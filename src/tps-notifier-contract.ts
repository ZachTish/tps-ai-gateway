// Canonical TPS Notifier inter-plugin contract.
// Consumer copies are synchronized by Plugin Development/sync-notifier-contract.mjs.

export const TPS_NOTIFIER_SERVICE_EVENTS = Object.freeze({
    REQUEST: 'tps:notifier-api-request',
    AVAILABLE: 'tps:notifier-api-available',
    UNAVAILABLE: 'tps:notifier-api-unavailable',
} as const);

export const TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION = 1 as const;
export const TPS_NOTIFIER_API_VERSION = 2 as const;
export const TPS_NOTIFIER_PROVIDER_PLUGIN_ID = 'tps-messager' as const;

export interface TPSNotifierDeliveryReceipt {
    readonly outcome: 'accepted';
    readonly httpStatus: number;
    readonly providerMessageId: string;
}

export type TPSNotifierErrorCode =
    | 'not-ready'
    | 'settings-read-only'
    | 'delivery-disabled'
    | 'delivery-invalidated'
    | 'transport-dirty'
    | 'invalid-configuration'
    | 'invalid-payload'
    | 'internal-error'
    | 'delivery-busy'
    | 'delivery-rejected'
    | 'delivery-unconfirmed';

export type TPSNotifierProviderDeliveryState = 'not-attempted' | 'rejected' | 'unconfirmed';

export interface TPSNotifierErrorShape {
    readonly code: TPSNotifierErrorCode;
    readonly attempted: boolean;
    readonly deliveryState: TPSNotifierProviderDeliveryState;
    /** Whether retrying can create a duplicate, not whether the same request will succeed. */
    readonly duplicateSafeToRetry: boolean;
    readonly httpStatus?: number;
}

export interface TPSNotifierDiagnostic {
    readonly valid: true;
    readonly serverHost: string;
    readonly secure: boolean;
    readonly priority: number;
    readonly hasClick: boolean;
    readonly bodyBytes: number;
}

export interface TPSNotifierApi<TFile = unknown> {
    readonly apiVersion: 2;
    readonly capabilities: Readonly<{
        structuredReceipts: true;
        redactedDiagnostics: true;
        stableSequenceIds: false;
    }>;
    send(request: Readonly<{ title?: string; body: string; file?: TFile }>): Promise<TPSNotifierDeliveryReceipt>;
    validate(request: Readonly<{ title?: string; body: string; file?: TFile }>): TPSNotifierDiagnostic;
    sendNotification(title: string, body: string, file?: TFile): Promise<void>;
    sendMessage(text: string, file?: TFile, title?: string): Promise<void>;
    /** @deprecated Sensitive compatibility surface. Prefer validate(). */
    dryRunMessage(text: string, file?: TFile, title?: string): unknown;
}

export interface TPSNotifierServiceDescriptor<TFile = unknown> {
    readonly protocolVersion: 1;
    readonly providerPluginId: 'tps-messager';
    readonly api: Readonly<TPSNotifierApi<TFile>>;
}

export interface TPSNotifierServiceRequest {
    readonly protocolVersion: 1;
    readonly consumerPluginId: string;
    readonly accept: (descriptor: unknown) => void;
}

export type TPSNotifierConsumerDeliveryState =
    | 'attempting'
    | 'accepted'
    | 'legacy-accepted'
    | 'rejected'
    | 'not-attempted'
    | 'unknown';

export type TPSNotifierConsumerTransport = 'notifier-v2' | 'notifier-v1' | 'unavailable' | 'unknown';

export type TPSNotifierConsumerEvidence =
    | 'structured-receipt'
    | 'structured-rejection'
    | 'structured-not-attempted'
    | 'unconfirmed'
    | 'legacy-promise-resolved'
    | 'legacy-rejection'
    | 'service-unavailable'
    | 'malformed-v2-result'
    | 'unclassified-v2-failure'
    | 'consumer-timeout'
    | 'interrupted'
    | 'legacy-untracked'
    | 'invalid-record';

export interface TPSNotifierConsumerDeliveryResult {
    readonly state: Exclude<TPSNotifierConsumerDeliveryState, 'attempting'>;
    readonly transport: TPSNotifierConsumerTransport;
    readonly evidence: TPSNotifierConsumerEvidence;
    /** Known provider-attempt status, or `unknown` when an unstructured boundary cannot prove it. */
    readonly attempted: boolean | 'unknown';
    readonly code?: TPSNotifierErrorCode;
    readonly httpStatus?: number;
    readonly providerMessageId?: string;
}

export interface TPSNotifierApiSnapshot<TFile = unknown> {
    readonly apiVersion: 2;
    readonly capabilities: Readonly<{
        structuredReceipts: true;
        redactedDiagnostics: true;
        stableSequenceIds: false;
    }>;
    readonly send: TPSNotifierApi<TFile>['send'];
    readonly validate: TPSNotifierApi<TFile>['validate'];
    /** Exact source identity for lifecycle withdrawal; never inspect its properties after parsing. */
    readonly sourceApi: object;
}

export interface TPSNotifierServiceDescriptorSnapshot<TFile = unknown> {
    readonly protocolVersion: 1;
    readonly providerPluginId: 'tps-messager';
    readonly api: Readonly<TPSNotifierApiSnapshot<TFile>>;
    /** Exact source identity for lifecycle withdrawal; never inspect its properties after parsing. */
    readonly sourceDescriptor: object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

const ERROR_CODES = new Set<string>([
    'not-ready',
    'settings-read-only',
    'delivery-disabled',
    'delivery-invalidated',
    'transport-dirty',
    'invalid-configuration',
    'invalid-payload',
    'internal-error',
    'delivery-busy',
    'delivery-rejected',
    'delivery-unconfirmed',
]);

export function parseTPSNotifierApiSnapshot<TFile = unknown>(
    value: unknown,
): Readonly<TPSNotifierApiSnapshot<TFile>> | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const apiVersion = value.apiVersion;
        const capabilitiesValue = value.capabilities;
        const sendValue = value.send;
        const validateValue = value.validate;
        if (apiVersion !== TPS_NOTIFIER_API_VERSION
            || !isRecord(capabilitiesValue)
            || typeof sendValue !== 'function'
            || typeof validateValue !== 'function') return undefined;
        const structuredReceipts = capabilitiesValue.structuredReceipts;
        const redactedDiagnostics = capabilitiesValue.redactedDiagnostics;
        const stableSequenceIds = capabilitiesValue.stableSequenceIds;
        if (structuredReceipts !== true
            || redactedDiagnostics !== true
            || stableSequenceIds !== false) return undefined;
        const sourceApi = value;
        const send = sendValue as TPSNotifierApi<TFile>['send'];
        const validate = validateValue as TPSNotifierApi<TFile>['validate'];
        const capabilities = Object.freeze({
            structuredReceipts: true as const,
            redactedDiagnostics: true as const,
            stableSequenceIds: false as const,
        });
        return Object.freeze({
            apiVersion: TPS_NOTIFIER_API_VERSION,
            capabilities,
            send: (request: Readonly<{ title?: string; body: string; file?: TFile }>) => (
                send.call(sourceApi, request)
            ),
            validate: (request: Readonly<{ title?: string; body: string; file?: TFile }>) => (
                validate.call(sourceApi, request)
            ),
            sourceApi,
        });
    } catch {
        return undefined;
    }
}

export function parseTPSNotifierDeliveryReceipt(
    value: unknown,
): Readonly<TPSNotifierDeliveryReceipt> | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const outcome = value.outcome;
        const httpStatus = value.httpStatus;
        const providerMessageId = value.providerMessageId;
        if (outcome !== 'accepted'
            || typeof httpStatus !== 'number'
            || !Number.isInteger(httpStatus)
            || httpStatus < 200
            || httpStatus >= 300
            || typeof providerMessageId !== 'string'
            || providerMessageId.length === 0
            || providerMessageId.length > 256) return undefined;
        return Object.freeze({ outcome, httpStatus, providerMessageId });
    } catch {
        return undefined;
    }
}

export function parseTPSNotifierErrorShape(
    value: unknown,
): Readonly<TPSNotifierErrorShape> | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const code = value.code;
        const attempted = value.attempted;
        const deliveryState = value.deliveryState;
        const duplicateSafeToRetry = value.duplicateSafeToRetry;
        const httpStatus = value.httpStatus;
        if (typeof code !== 'string'
            || !ERROR_CODES.has(code)
            || (deliveryState !== 'not-attempted'
                && deliveryState !== 'rejected'
                && deliveryState !== 'unconfirmed')
            || typeof attempted !== 'boolean'
            || typeof duplicateSafeToRetry !== 'boolean') return undefined;
        if (httpStatus !== undefined
            && (typeof httpStatus !== 'number'
                || !Number.isInteger(httpStatus)
                || httpStatus < 100
                || httpStatus > 599)) return undefined;
        if (deliveryState === 'not-attempted') {
            if (attempted !== false || duplicateSafeToRetry !== true) return undefined;
        } else if (deliveryState === 'rejected') {
            if (attempted !== true || duplicateSafeToRetry !== true) return undefined;
        } else if (attempted !== true || duplicateSafeToRetry !== false) {
            return undefined;
        }
        return Object.freeze({
            code: code as TPSNotifierErrorCode,
            attempted,
            deliveryState,
            duplicateSafeToRetry,
            ...(httpStatus === undefined ? {} : { httpStatus }),
        });
    } catch {
        return undefined;
    }
}

export function parseTPSNotifierServiceDescriptor<TFile = unknown>(
    value: unknown,
): Readonly<TPSNotifierServiceDescriptorSnapshot<TFile>> | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const protocolVersion = value.protocolVersion;
        const providerPluginId = value.providerPluginId;
        const apiValue = value.api;
        if (protocolVersion !== TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION
            || providerPluginId !== TPS_NOTIFIER_PROVIDER_PLUGIN_ID) return undefined;
        const api = parseTPSNotifierApiSnapshot<TFile>(apiValue);
        if (!api) return undefined;
        return Object.freeze({
            protocolVersion,
            providerPluginId,
            api,
            sourceDescriptor: value,
        });
    } catch {
        return undefined;
    }
}

export function parseTPSNotifierServiceRequest(
    value: unknown,
): Readonly<TPSNotifierServiceRequest> | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const protocolVersion = value.protocolVersion;
        const consumerPluginId = value.consumerPluginId;
        const acceptValue = value.accept;
        if (protocolVersion !== TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION
            || typeof consumerPluginId !== 'string'
            || consumerPluginId.length === 0
            || consumerPluginId.length > 128
            || typeof acceptValue !== 'function') return undefined;
        const accept = acceptValue as TPSNotifierServiceRequest['accept'];
        return Object.freeze({
            protocolVersion,
            consumerPluginId,
            accept: (descriptor: unknown) => accept.call(value, descriptor),
        });
    } catch {
        return undefined;
    }
}

/** Compatibility predicates. Hostile boundaries should consume the normalized parsers above. */
export function isTPSNotifierApi(value: unknown): value is Readonly<TPSNotifierApi> {
    return parseTPSNotifierApiSnapshot(value) !== undefined;
}

export function isTPSNotifierDeliveryReceipt(value: unknown): value is TPSNotifierDeliveryReceipt {
    return parseTPSNotifierDeliveryReceipt(value) !== undefined;
}

export function isTPSNotifierErrorShape(value: unknown): value is TPSNotifierErrorShape {
    return parseTPSNotifierErrorShape(value) !== undefined;
}

export function isTPSNotifierServiceDescriptor(value: unknown): value is TPSNotifierServiceDescriptor {
    return parseTPSNotifierServiceDescriptor(value) !== undefined;
}

export function isTPSNotifierServiceRequest(value: unknown): value is TPSNotifierServiceRequest {
    return parseTPSNotifierServiceRequest(value) !== undefined;
}
