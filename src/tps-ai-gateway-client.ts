// Canonical TPS AI Gateway consumer adapter. It intentionally has no private-registry fallback.

import type { App, EventRef, Events } from "obsidian";
import {
  parseTPSAiGatewayServiceDescriptor,
  TPS_AI_GATEWAY_SERVICE_EVENTS,
  TPS_AI_GATEWAY_SERVICE_PROTOCOL_VERSION,
  type TPSAiGatewayApiSnapshot,
  type TPSAiGatewayServiceDescriptorSnapshot,
  type TPSAiGatewayServiceRequest,
} from "./tps-ai-gateway-contract";

export type TPSAiGatewayAvailabilityChanged = (
  api: Readonly<TPSAiGatewayApiSnapshot> | undefined,
) => void;

export class TPSAiGatewayClient {
  private descriptor?: Readonly<TPSAiGatewayServiceDescriptorSnapshot>;
  private started = false;
  private lifecycleEpoch = 0;
  private availabilityChanged?: TPSAiGatewayAvailabilityChanged;
  private lastNotifiedSourceApi?: object;
  private hasNotifiedUnavailable = false;
  private requestSequence = 0;

  constructor(
    private readonly app: App,
    private readonly consumerPluginId: string,
  ) {}

  start(
    registerEvent: (eventRef: EventRef) => void,
    onAvailabilityChanged?: TPSAiGatewayAvailabilityChanged,
  ): void {
    if (this.started) return;
    this.started = true;
    this.availabilityChanged = onAvailabilityChanged;
    const epoch = ++this.lifecycleEpoch;
    const events = this.app.workspace as Events;
    registerEvent(events.on(TPS_AI_GATEWAY_SERVICE_EVENTS.AVAILABLE, (...args: unknown[]) => {
      try {
        this.acceptDescriptor(args[0], epoch);
      } catch {
        // A malformed or reentrant provider event must not destabilize the consumer.
      }
    }));
    registerEvent(events.on(TPS_AI_GATEWAY_SERVICE_EVENTS.UNAVAILABLE, (...args: unknown[]) => {
      try {
        if (!this.isCurrent(epoch)) return;
        const withdrawn = parseTPSAiGatewayServiceDescriptor(args[0]);
        if (!withdrawn || !this.isCurrent(epoch) || !this.descriptor) return;
        if (withdrawn.sourceDescriptor === this.descriptor.sourceDescriptor
          || withdrawn.api.sourceApi === this.descriptor.api.sourceApi) {
          this.descriptor = undefined;
          this.notifyAvailability();
        }
      } catch {
        // Ignore malformed or reentrant lifecycle announcements.
      }
    }));
    this.requestCurrentDescriptor(epoch);
    this.notifyAvailability();
  }

  dispose(): void {
    if (!this.started) return;
    this.lifecycleEpoch += 1;
    this.started = false;
    this.descriptor = undefined;
    this.notifyAvailability();
    this.availabilityChanged = undefined;
    this.lastNotifiedSourceApi = undefined;
    this.hasNotifiedUnavailable = false;
  }

  getApi(): Readonly<TPSAiGatewayApiSnapshot> | undefined {
    const epoch = this.lifecycleEpoch;
    if (!this.isCurrent(epoch)) return undefined;
    this.requestCurrentDescriptor(epoch);
    if (!this.isCurrent(epoch)) return undefined;
    return this.descriptor?.api;
  }

  private isCurrent(epoch: number): boolean {
    return this.started && epoch === this.lifecycleEpoch;
  }

  private acceptDescriptor(value: unknown, epoch: number): void {
    if (!this.isCurrent(epoch)) return;
    const descriptor = parseTPSAiGatewayServiceDescriptor(value);
    if (!descriptor || !this.isCurrent(epoch)) return;
    if (this.descriptor?.sourceDescriptor === descriptor.sourceDescriptor
      || this.descriptor?.api.sourceApi === descriptor.api.sourceApi) return;
    this.descriptor = descriptor;
    this.notifyAvailability();
  }

  private requestCurrentDescriptor(epoch: number): void {
    if (!this.isCurrent(epoch)) return;
    const requestSequence = ++this.requestSequence;
    let accepting = true;
    const request: TPSAiGatewayServiceRequest = Object.freeze({
      protocolVersion: TPS_AI_GATEWAY_SERVICE_PROTOCOL_VERSION,
      consumerPluginId: this.consumerPluginId,
      accept: (descriptor: unknown) => {
        try {
          if (!accepting || requestSequence !== this.requestSequence) return;
          this.acceptDescriptor(descriptor, epoch);
        } catch {
          // Ignore delayed or hostile provider callbacks.
        }
      },
    });
    try {
      this.app.workspace.trigger(TPS_AI_GATEWAY_SERVICE_EVENTS.REQUEST, request);
    } catch {
      // Preserve a previously validated descriptor if another request listener throws.
    } finally {
      accepting = false;
    }
  }

  private notifyAvailability(): void {
    const callback = this.availabilityChanged;
    if (!callback) return;
    const api = this.descriptor?.api;
    if (api) {
      if (this.lastNotifiedSourceApi === api.sourceApi) return;
      this.lastNotifiedSourceApi = api.sourceApi;
      this.hasNotifiedUnavailable = false;
    } else {
      if (this.hasNotifiedUnavailable && this.lastNotifiedSourceApi === undefined) return;
      this.lastNotifiedSourceApi = undefined;
      this.hasNotifiedUnavailable = true;
    }
    try {
      callback(api);
    } catch {
      // Consumer callbacks are isolated from discovery and other listeners.
    }
  }
}
