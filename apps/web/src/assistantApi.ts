import { api } from "./api";
import type {
  AssistantAction,
  AssistantCommand,
  AssistantConversation,
  AssistantConversationSummary,
} from "./assistantTypes";

const conversationPath = (id: string) =>
  `/assistant/conversations/${encodeURIComponent(id)}`;
const actionPath = (cid: string, aid: string) =>
  `${conversationPath(cid)}/actions/${encodeURIComponent(aid)}`;
export const assistantApi = {
  status: (signal?: AbortSignal) =>
    api<{ configured: boolean; model: string }>("/assistant/status", {
      signal,
    }),
  list: (signal?: AbortSignal) =>
    api<AssistantConversationSummary[]>("/assistant/conversations", { signal }),
  create: (signal?: AbortSignal) =>
    api<AssistantConversation>("/assistant/conversations", {
      method: "POST",
      body: {},
      signal,
    }),
  get: (id: string, signal?: AbortSignal) =>
    api<AssistantConversation>(conversationPath(id), { signal }),
  remove: (id: string) =>
    api<{ deleted: boolean }>(conversationPath(id), { method: "DELETE" }),
  send: (id: string, content: string, context: unknown, signal: AbortSignal) =>
    api<AssistantConversation>(`${conversationPath(id)}/messages`, {
      method: "POST",
      body: { content, context },
      signal,
    }),
  act: (cid: string, aid: string, confirmation?: string) =>
    api<{
      action: AssistantAction;
      command?: AssistantCommand;
      outcome?: string;
    }>(actionPath(cid, aid), {
      method: "POST",
      body: confirmation === undefined ? {} : { confirmation },
    }),
  cancel: (cid: string, aid: string) =>
    api<{ action: AssistantAction }>(`${actionPath(cid, aid)}/cancel`, {
      method: "POST",
      body: {},
    }),
  result: (
    cid: string,
    aid: string,
    result: { ok: boolean; message: string },
  ) =>
    api<unknown>(`${actionPath(cid, aid)}/result`, {
      method: "POST",
      body: result,
    }),
};
