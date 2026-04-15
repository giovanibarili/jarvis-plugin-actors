export interface ActorRole {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export type ActorStatus = "idle" | "running" | "waiting_tools" | "stopped";

export interface Actor {
  id: string;
  role: ActorRole;
  status: ActorStatus;
  createdAt: number;
  taskCount: number;
  currentTask?: string;
  lastResult?: string;
  replySessionId: string;
  chatHistory: Array<{ role: 'user' | 'actor'; text: string; source?: string }>;
}

export interface ActorDispatchEvent {
  name: string;
  role: ActorRole;
  task: string;
  replySessionId: string;
}

export interface ActorDispatchResultEvent {
  name: string;
  result: string;
  replySessionId: string;
}

export const BUILT_IN_ROLES: ActorRole[] = [
  {
    id: "generic",
    name: "Generic Worker",
    description: "General-purpose worker. Can handle any task the core delegates.",
    systemPrompt: "You are a worker agent for JARVIS. Execute tasks given to you autonomously. Use the available tools as needed. Be thorough and report your results clearly. Do not ask questions — make reasonable decisions and proceed.",
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Investigates topics, reads files, searches codebases. Read-only, never modifies files.",
    systemPrompt: "You are a research agent for JARVIS. Your job is to investigate, analyze, and report findings. Read files, search codebases, browse documentation. NEVER modify files — you are read-only. Be thorough and cite sources (file paths, line numbers).",
  },
  {
    id: "coder",
    name: "Coder",
    description: "Writes and edits code. Creates files, implements features, fixes bugs.",
    systemPrompt: "You are a coding agent for JARVIS. Write clean, correct code. Use edit_file for surgical changes, write_file for new files. Run bash to test. Follow existing patterns in the codebase. Commit nothing — just make the changes.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews code for correctness, style, bugs. Read-only analysis.",
    systemPrompt: "You are a code review agent for JARVIS. Analyze the code for bugs, style issues, security problems, and architectural concerns. Be specific — cite file paths and line numbers. Rate severity: critical, important, suggestion. NEVER modify files.",
  },
];

export const MAX_ACTORS = 5;
export const MAX_TOOL_ROUNDS = 15;
export const MAX_CHAT_HISTORY = 500;
