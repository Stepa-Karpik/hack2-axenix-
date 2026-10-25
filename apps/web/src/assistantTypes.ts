export type AssistantActionType =
  | "navigate"
  | "set_theme"
  | "show_panel"
  | "guide"
  | "find_symbol"
  | "run_tests"
  | "run_program"
  | "workspace_action"
  | "optimize"
  | "set_visibility"
  | "pin_project"
  | "update_profile"
  | "friend_request"
  | "friend_accept"
  | "friend_decline"
  | "friend_remove"
  | "project_role"
  | "code_edit"
  | "layout_action"
  | "explain";
export interface AssistantCommand {
  type: AssistantActionType;
  args: Record<string, unknown>;
}
export interface AssistantAction extends AssistantCommand {
  id: string;
  risk: "none" | "confirm" | "typed";
  label: string;
  description: string;
  status: "pending" | "completed" | "cancelled";
}
export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  actions?: AssistantAction[];
}
export interface AssistantConversation {
  id: string;
  title: string;
  messages: AssistantMessage[];
}
export interface AssistantConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}
