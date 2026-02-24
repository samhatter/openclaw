import { describe, expect, it } from "vitest";
import { resolveInboundContextOptions } from "./envelope.js";
import type { OpenClawConfig } from "../config/config.js";

describe("resolveInboundContextOptions", () => {
  it("defaults all options to true when no config provided", () => {
    const opts = resolveInboundContextOptions({});
    expect(opts.includeSystemEnvelope).toBe(true);
    expect(opts.includeConversationInfo).toBe(true);
    expect(opts.includeSenderInfo).toBe(true);
  });

  it("uses agent defaults when set", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: false,
            includeConversationInfo: false,
            includeSenderInfo: false,
          },
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg });
    expect(opts.includeSystemEnvelope).toBe(false);
    expect(opts.includeConversationInfo).toBe(false);
    expect(opts.includeSenderInfo).toBe(false);
  });

  it("uses channel defaults over agent defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: false,
            includeConversationInfo: false,
            includeSenderInfo: false,
          },
        },
      },
      channels: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: true,
            includeConversationInfo: true,
            includeSenderInfo: true,
          },
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg });
    expect(opts.includeSystemEnvelope).toBe(true);
    expect(opts.includeConversationInfo).toBe(true);
    expect(opts.includeSenderInfo).toBe(true);
  });

  it("uses channel-specific overrides over channel defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: true,
            includeConversationInfo: true,
            includeSenderInfo: true,
          },
        },
      },
      channels: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: true,
            includeConversationInfo: true,
            includeSenderInfo: true,
          },
        },
        telegram: {
          inboundContext: {
            includeSystemEnvelope: false,
            includeConversationInfo: false,
            includeSenderInfo: false,
          },
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg, channelId: "telegram" });
    expect(opts.includeSystemEnvelope).toBe(false);
    expect(opts.includeConversationInfo).toBe(false);
    expect(opts.includeSenderInfo).toBe(false);
  });

  it("allows partial channel overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: true,
            includeConversationInfo: true,
            includeSenderInfo: true,
          },
        },
      },
      channels: {
        discord: {
          inboundContext: {
            includeConversationInfo: false,
          },
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg, channelId: "discord" });
    expect(opts.includeSystemEnvelope).toBe(true);
    expect(opts.includeConversationInfo).toBe(false);
    expect(opts.includeSenderInfo).toBe(true);
  });

  it("falls back to agent defaults when channel has no overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: false,
            includeConversationInfo: true,
            includeSenderInfo: false,
          },
        },
      },
      channels: {
        telegram: {
          enabled: true,
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg, channelId: "telegram" });
    expect(opts.includeSystemEnvelope).toBe(false);
    expect(opts.includeConversationInfo).toBe(true);
    expect(opts.includeSenderInfo).toBe(false);
  });

  it("handles mixed precedence correctly", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: false,
            includeConversationInfo: false,
            includeSenderInfo: false,
          },
        },
      },
      channels: {
        defaults: {
          inboundContext: {
            includeSystemEnvelope: true,
          },
        },
        whatsapp: {
          inboundContext: {
            includeSenderInfo: true,
          },
        },
      },
    };
    const opts = resolveInboundContextOptions({ cfg, channelId: "whatsapp" });
    // channel override > channel defaults > agent defaults > true (default)
    expect(opts.includeSystemEnvelope).toBe(true); // from channel defaults
    expect(opts.includeConversationInfo).toBe(false); // from agent defaults
    expect(opts.includeSenderInfo).toBe(true); // from channel override
  });
});
