/**
 * Tool composition root. `createToolRegistry` builds the registry of all tool
 * definitions. Per-call dependencies (config, logger, and later auth/gmail/audit)
 * are supplied through `ToolContext` at invocation time, so the registry holds
 * pure definitions and stays free of runtime wiring.
 *
 * As later phases land their tools (profile, search, attachments, write tools,
 * …), register them here.
 */

import { ToolRegistry } from '../mcp/toolRegistry.js';
import { healthTool } from './health.js';
import { gmailGetProfileTool } from './gmailGetProfile.js';
import { gmailListLabelsTool } from './gmailListLabels.js';
import { gmailSearchMessagesTool } from './gmailSearchMessages.js';
import { gmailGetMessageTool } from './gmailGetMessage.js';
import { gmailGetThreadTool } from './gmailGetThread.js';
import { gmailListAttachmentsTool } from './gmailListAttachments.js';
import { gmailGetAttachmentTool } from './gmailGetAttachment.js';
import { gmailSaveAttachmentTool } from './gmailSaveAttachment.js';
import { gmailSaveAttachmentsTool } from './gmailSaveAttachments.js';
import { gmailCreateDraftTool } from './gmailCreateDraft.js';
import { gmailListDraftsTool } from './gmailListDrafts.js';
import { gmailSendDraftTool } from './gmailSendDraft.js';
import { gmailSendMessageTool } from './gmailSendMessage.js';
import { gmailModifyMessageLabelsTool } from './gmailModifyMessageLabels.js';

/** Build the registry with every available tool registered. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(healthTool);
  registry.register(gmailGetProfileTool);
  registry.register(gmailListLabelsTool);
  registry.register(gmailSearchMessagesTool);
  registry.register(gmailGetMessageTool);
  registry.register(gmailGetThreadTool);
  registry.register(gmailListAttachmentsTool);
  registry.register(gmailGetAttachmentTool);
  registry.register(gmailSaveAttachmentTool);
  registry.register(gmailSaveAttachmentsTool);
  registry.register(gmailCreateDraftTool);
  registry.register(gmailListDraftsTool);
  registry.register(gmailSendDraftTool);
  registry.register(gmailSendMessageTool);
  registry.register(gmailModifyMessageLabelsTool);
  return registry;
}
