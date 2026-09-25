const names: Record<string, string> = { all: 'All sources', codex: 'Codex', opencode: 'OpenCode' };

export const sourceName = (id: string | null): string | null => names[id ?? ''] || id;
