#!/usr/bin/env node
// `scribbit-mcp` executable: the stdio MCP server. Registers tsx so the TypeScript sources (workspace
// convention: no build step) run directly. Use `claude mcp add scribbit -- scribbit-mcp`.
import { register } from 'tsx/esm/api';

register();
await import('../src/stdio.ts');
