// Loaded with --import: makes server.js use the stub agent instead of lib/agent.js.
import { register } from 'node:module';

register('./stub-hooks.mjs', import.meta.url);
