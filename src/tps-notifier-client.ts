// Canonical TPS Notifier consumer adapter.
// Consumer copies are synchronized by Plugin Development/sync-notifier-contract.mjs.

import type { App, EventRef, Events } from 'obsidian';
import {
    parseTPSNotifierDeliveryReceipt,
    parseTPSNotifierErrorShape,
    parseTPSNotifierServiceDescriptor,
    TPS_NOTIFIER_SERVICE_EVENTS,
    TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION,
    type TPSNotifierConsumerDeliveryResult,
    type TPSNotifierConsumerTransport,
    type TPSNotifierServiceDescriptorSnapshot,
    type TPSNotifierServiceRequest,
} from './tps-notifier-contract';

export const TPS_NOTIFIER_DEFAULT_PROVIDER_DEADLINE_MS = 60_000;
export const TPS_NOTIFIER_MAX_PROVIDER_DEADLINE_MS = 5 * 60_000;

export interface TPSNotifierClientOptions {
    /** Consumer-side wait bound. It does not cancel provider I/O or make a retry duplicate-safe. */
    readonly providerDeadlineMs?: number;
}

interface LegacyPluginRegistry {
    getPlugin?: (pluginId: string) => unknown;
}

interface LegacyPluginContainer {
    plugins?: LegacyPluginRegistry;
}

interface ConsumerDeliveryRequest<TFile> {
    readonly title?: string;
    readonly body: string;
    readonly file?: TFile;
}

interface LegacyNotifierSnapshot<TFile> {
    readonly invoke: (request: Readonly<ConsumerDeliveryRequest<TFile>>) => Promise<void>;
}

type ProviderCallOutcome<T> =
    | Readonly<{ kind: 'resolved'; value: T }>
    | Readonly<{ kind: 'rejected'; error: unknown }>
    | Readonly<{ kind: 'timeout' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderDeadline(value: unknown): number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        && value <= TPS_NOTIFIER_MAX_PROVIDER_DEADLINE_MS
        ? value
        : TPS_NOTIFIER_DEFAULT_PROVIDER_DEADLINE_MS;
}

export class TPSNotifierClient<TFile = unknown> {
    private descriptor?: Readonly<TPSNotifierServiceDescriptorSnapshot<TFile>>;
    private started = false;
    private lifecycleEpoch = 0;
    private readonly providerDeadlineMs: number;

    constructor(
        private readonly app: App,
        private readonly consumerPluginId: string,
        options: Readonly<TPSNotifierClientOptions> = {},
    ) {
        this.providerDeadlineMs = normalizeProviderDeadline(options.providerDeadlineMs);
    }

    start(registerEvent: (eventRef: EventRef) => void): void {
        if (this.started) return;
        this.started = true;
        const epoch = ++this.lifecycleEpoch;
        const events = this.app.workspace as Events;
        registerEvent(events.on(TPS_NOTIFIER_SERVICE_EVENTS.AVAILABLE, (...args: unknown[]) => {
            try {
                this.acceptDescriptor(args[0], epoch);
            } catch {
                // A consumer event boundary must never destabilize its host plugin.
            }
        }));
        registerEvent(events.on(TPS_NOTIFIER_SERVICE_EVENTS.UNAVAILABLE, (...args: unknown[]) => {
            try {
                if (!this.isCurrent(epoch)) return;
                const withdrawn = parseTPSNotifierServiceDescriptor<TFile>(args[0]);
                if (!withdrawn || !this.isCurrent(epoch) || !this.descriptor) return;
                if (withdrawn.sourceDescriptor === this.descriptor.sourceDescriptor
                    || withdrawn.api.sourceApi === this.descriptor.api.sourceApi) {
                    this.descriptor = undefined;
                }
            } catch {
                // Ignore malformed or reentrant lifecycle announcements.
            }
        }));
        this.requestCurrentDescriptor(epoch);
    }

    dispose(): void {
        this.lifecycleEpoch += 1;
        this.started = false;
        this.descriptor = undefined;
    }

    async send(request: Readonly<ConsumerDeliveryRequest<TFile>>): Promise<TPSNotifierConsumerDeliveryResult> {
        const epoch = this.lifecycleEpoch;
        if (!this.isCurrent(epoch)) return this.interruptedBeforeAttempt();

        const descriptor = this.resolveV2Descriptor(epoch);
        if (descriptor) return await this.sendV2(descriptor, request, epoch);
        if (!this.isCurrent(epoch)) return this.interruptedBeforeAttempt();

        const legacy = this.resolveLegacyV1Notifier();
        if (!this.isCurrent(epoch)) return this.interruptedBeforeAttempt();
        if (legacy) return await this.sendV1(legacy, request, epoch);
        return Object.freeze({
            state: 'not-attempted' as const,
            transport: 'unavailable' as const,
            evidence: 'service-unavailable' as const,
            attempted: false,
        });
    }

    private isCurrent(epoch: number): boolean {
        return this.started && epoch === this.lifecycleEpoch;
    }

    private interruptedBeforeAttempt(): TPSNotifierConsumerDeliveryResult {
        return Object.freeze({
            state: 'not-attempted' as const,
            transport: 'unavailable' as const,
            evidence: 'interrupted' as const,
            attempted: false,
        });
    }

    private acceptDescriptor(value: unknown, epoch: number): void {
        if (!this.isCurrent(epoch)) return;
        const descriptor = parseTPSNotifierServiceDescriptor<TFile>(value);
        if (!descriptor || !this.isCurrent(epoch)) return;
        this.descriptor = descriptor;
    }

    private requestCurrentDescriptor(epoch: number): void {
        if (!this.isCurrent(epoch)) return;
        const request: TPSNotifierServiceRequest = Object.freeze({
            protocolVersion: TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION,
            consumerPluginId: this.consumerPluginId,
            accept: (descriptor: unknown) => {
                try {
                    this.acceptDescriptor(descriptor, epoch);
                } catch {
                    // A delayed or hostile provider callback is ignored.
                }
            },
        });
        try {
            this.app.workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, request);
        } catch {
            // Preserve any valid cached descriptor and allow the isolated v1 bridge below.
        }
    }

    private resolveV2Descriptor(
        epoch: number,
    ): Readonly<TPSNotifierServiceDescriptorSnapshot<TFile>> | undefined {
        this.requestCurrentDescriptor(epoch);
        if (!this.isCurrent(epoch)) return undefined;
        return this.descriptor;
    }

    private snapshotDeliveryRequest(
        request: Readonly<ConsumerDeliveryRequest<TFile>>,
    ): Readonly<ConsumerDeliveryRequest<TFile>> | undefined {
        try {
            const title = request.title;
            const body = request.body;
            const file = request.file;
            return Object.freeze({ title, body, file });
        } catch {
            return undefined;
        }
    }

    private async sendV2(
        descriptor: Readonly<TPSNotifierServiceDescriptorSnapshot<TFile>>,
        request: Readonly<ConsumerDeliveryRequest<TFile>>,
        epoch: number,
    ): Promise<TPSNotifierConsumerDeliveryResult> {
        const requestSnapshot = this.snapshotDeliveryRequest(request);
        if (!requestSnapshot) {
            return Object.freeze({
                state: 'unknown' as const,
                transport: 'notifier-v2' as const,
                evidence: 'unclassified-v2-failure' as const,
                attempted: 'unknown' as const,
            });
        }
        if (!this.isCurrent(epoch)) return this.interruptedBeforeAttempt();
        const outcome = await this.invokeWithDeadline(() => descriptor.api.send(requestSnapshot));
        if (outcome.kind === 'timeout') return this.consumerTimeout('notifier-v2');
        if (outcome.kind === 'resolved') {
            const receipt = parseTPSNotifierDeliveryReceipt(outcome.value);
            if (!receipt) {
                return Object.freeze({
                    state: 'unknown' as const,
                    transport: 'notifier-v2' as const,
                    evidence: 'malformed-v2-result' as const,
                    attempted: 'unknown' as const,
                });
            }
            return Object.freeze({
                state: 'accepted' as const,
                transport: 'notifier-v2' as const,
                evidence: 'structured-receipt' as const,
                attempted: true,
                httpStatus: receipt.httpStatus,
                providerMessageId: receipt.providerMessageId,
            });
        }

        const error = parseTPSNotifierErrorShape(outcome.error);
        if (!error) {
            return Object.freeze({
                state: 'unknown' as const,
                transport: 'notifier-v2' as const,
                evidence: 'unclassified-v2-failure' as const,
                attempted: 'unknown' as const,
            });
        }
        if (error.code === 'not-ready'
            && this.isCurrent(epoch)
            && this.descriptor?.api.sourceApi === descriptor.api.sourceApi) {
            this.descriptor = undefined;
        }
        if (error.deliveryState === 'not-attempted') {
            return Object.freeze({
                state: 'not-attempted' as const,
                transport: 'notifier-v2' as const,
                evidence: 'structured-not-attempted' as const,
                attempted: false,
                code: error.code,
                ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
            });
        }
        if (error.deliveryState === 'rejected') {
            return Object.freeze({
                state: 'rejected' as const,
                transport: 'notifier-v2' as const,
                evidence: 'structured-rejection' as const,
                attempted: true,
                code: error.code,
                ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
            });
        }
        return Object.freeze({
            state: 'unknown' as const,
            transport: 'notifier-v2' as const,
            evidence: 'unconfirmed' as const,
            attempted: true,
            code: error.code,
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        });
    }

    /**
     * Temporary mixed-version bridge. Obsidian exposes no public plugin lookup API,
     * so this is the single contained compatibility exception until every device runs v2.
     */
    private resolveLegacyV1Notifier(): Readonly<LegacyNotifierSnapshot<TFile>> | undefined {
        try {
            const registry = (this.app as App & LegacyPluginContainer).plugins;
            if (!isRecord(registry)) return undefined;
            const getPluginValue = registry.getPlugin;
            if (typeof getPluginValue !== 'function') return undefined;
            for (const pluginId of ['tps-messager', 'tps-notifier']) {
                const plugin = getPluginValue.call(registry, pluginId);
                if (!isRecord(plugin)) continue;
                const api = plugin.api;
                if (!isRecord(api)) continue;
                const sendNotificationValue = api.sendNotification;
                if (typeof sendNotificationValue === 'function') {
                    const sendNotification = sendNotificationValue as (
                        title: string,
                        body: string,
                        file?: TFile,
                    ) => Promise<void>;
                    return Object.freeze({
                        invoke: async (request: Readonly<ConsumerDeliveryRequest<TFile>>) => {
                            await sendNotification.call(api, request.title || '', request.body, request.file);
                        },
                    });
                }
                const sendMessageValue = api.sendMessage;
                if (typeof sendMessageValue !== 'function') continue;
                const sendMessage = sendMessageValue as (
                    text: string,
                    file?: TFile,
                    title?: string,
                ) => Promise<void>;
                return Object.freeze({
                    invoke: async (request: Readonly<ConsumerDeliveryRequest<TFile>>) => {
                        await sendMessage.call(api, request.body, request.file, request.title || '');
                    },
                });
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private async sendV1(
        notifier: Readonly<LegacyNotifierSnapshot<TFile>>,
        request: Readonly<ConsumerDeliveryRequest<TFile>>,
        epoch: number,
    ): Promise<TPSNotifierConsumerDeliveryResult> {
        const requestSnapshot = this.snapshotDeliveryRequest(request);
        if (!requestSnapshot) {
            return Object.freeze({
                state: 'unknown' as const,
                transport: 'notifier-v1' as const,
                evidence: 'legacy-rejection' as const,
                attempted: 'unknown' as const,
            });
        }
        if (!this.isCurrent(epoch)) return this.interruptedBeforeAttempt();
        const outcome = await this.invokeWithDeadline(() => notifier.invoke(requestSnapshot));
        if (outcome.kind === 'timeout') return this.consumerTimeout('notifier-v1');
        if (outcome.kind === 'rejected') {
            return Object.freeze({
                state: 'unknown' as const,
                transport: 'notifier-v1' as const,
                evidence: 'legacy-rejection' as const,
                attempted: 'unknown' as const,
            });
        }
        return Object.freeze({
            state: 'legacy-accepted' as const,
            transport: 'notifier-v1' as const,
            evidence: 'legacy-promise-resolved' as const,
            attempted: true,
        });
    }

    private consumerTimeout(transport: TPSNotifierConsumerTransport): TPSNotifierConsumerDeliveryResult {
        return Object.freeze({
            state: 'unknown' as const,
            transport,
            evidence: 'consumer-timeout' as const,
            attempted: 'unknown' as const,
        });
    }

    private async invokeWithDeadline<T>(invoke: () => Promise<T>): Promise<ProviderCallOutcome<T>> {
        let operation: Promise<T>;
        try {
            operation = Promise.resolve(invoke());
        } catch (error) {
            return Object.freeze({ kind: 'rejected' as const, error });
        }

        const settlement = operation.then<ProviderCallOutcome<T>, ProviderCallOutcome<T>>(
            (value) => Object.freeze({ kind: 'resolved' as const, value }),
            (error: unknown) => Object.freeze({ kind: 'rejected' as const, error }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<ProviderCallOutcome<T>>((resolve) => {
            timer = setTimeout(() => resolve(Object.freeze({ kind: 'timeout' as const })), this.providerDeadlineMs);
        });
        try {
            return await Promise.race([settlement, timeout]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}
