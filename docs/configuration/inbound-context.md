# Inbound Context Configuration

OpenClaw can inject metadata envelopes into inbound user messages to provide context to the AI model. These settings control what metadata is included in the prompt text.

## Overview

By default, OpenClaw prepends transport/context information to inbound messages:

- **System envelope**: Bracketed header like `[iMessage +1555 Mon 2026-02-23 16:05:10]`
- **Conversation info block**: JSON metadata about the conversation (message IDs, group info, flags)
- **Sender info block**: JSON metadata about the sender (name, username, etc.)

While useful for debugging and routing, these blocks can pollute prompt context and increase token usage. You can now disable them selectively.

## Configuration

### Global Defaults

Configure global defaults under `agents.defaults.inboundContext`:

```yaml
agents:
  defaults:
    inboundContext:
      # Include system envelope line (e.g., "[iMessage +1555]")
      includeSystemEnvelope: true  # default: true
      
      # Include "Conversation info (untrusted metadata)" block
      includeConversationInfo: true  # default: true
      
      # Include "Sender (untrusted metadata)" block
      includeSenderInfo: true  # default: true
```

### Channel-Level Defaults

Override for all channels under `channels.defaults.inboundContext`:

```yaml
channels:
  defaults:
    inboundContext:
      includeSystemEnvelope: false
      includeConversationInfo: false
      includeSenderInfo: false
```

### Per-Channel Overrides

Override for specific channels:

```yaml
channels:
  telegram:
    inboundContext:
      includeSystemEnvelope: false
      includeConversationInfo: true
      includeSenderInfo: false
  
  discord:
    inboundContext:
      includeSystemEnvelope: true
      includeConversationInfo: false
      includeSenderInfo: false
```

## Precedence

Settings are merged with the following precedence (highest to lowest):

1. **Channel-specific override** (`channels.<channel>.inboundContext`)
2. **Channel defaults** (`channels.defaults.inboundContext`)
3. **Agent defaults** (`agents.defaults.inboundContext`)
4. **Built-in default** (`true`)

## Examples

### Minimal Context (Clean Prompts)

Remove all envelope metadata for cleaner prompts:

```yaml
agents:
  defaults:
    inboundContext:
      includeSystemEnvelope: false
      includeConversationInfo: false
      includeSenderInfo: false
```

**Result**: The model sees only user-authored message text with no metadata blocks.

### Group Chat Context Only

Keep conversation metadata for group chats but remove sender details:

```yaml
agents:
  defaults:
    inboundContext:
      includeSystemEnvelope: true
      includeConversationInfo: true
      includeSenderInfo: false
```

### Channel-Specific Tuning

Disable system envelopes for Telegram but keep them for Discord:

```yaml
agents:
  defaults:
    inboundContext:
      includeSystemEnvelope: true

channels:
  telegram:
    inboundContext:
      includeSystemEnvelope: false
```

## Impact

### What is Preserved

Even with all toggles disabled, OpenClaw still maintains:

- **Reply routing**: Messages are routed to the correct conversation/thread
- **Session association**: Chat history and context continuity
- **Thread correlation**: Reply-to and threading metadata
- **Provider/channel adapters**: Internal metadata plumbing

### What Changes

With all toggles set to `false`:

- **Prompt text**: Contains only the user's message content
- **Token usage**: Reduced by removing metadata blocks
- **Model comprehension**: Cleaner input without repetitive transport noise

## Use Cases

### When to Disable

- **Token optimization**: Reduce context bloat in high-volume chats
- **Cleaner prompts**: Remove technical metadata for better model focus
- **Privacy**: Minimize metadata exposure in prompt logs
- **Testing**: Isolate message content from envelope formatting

### When to Keep Enabled

- **Debugging**: Envelope metadata helps trace message flow
- **Group chats**: Conversation info provides essential context
- **Multi-channel**: System envelope clarifies message source
- **Development**: Full context aids troubleshooting

## Migration

Existing deployments are **unaffected**. All options default to `true`, preserving current behavior.

To adopt cleaner prompts:

1. Start with a single channel: `channels.telegram.inboundContext.includeSystemEnvelope: false`
2. Test routing/threading still works correctly
3. Gradually disable other options as needed
4. Monitor for any routing regressions

## See Also

- [Configuration Overview](/configuration)
- [Envelope Format Options](/configuration/envelope-format)
- [Channel Configuration](/channels)
