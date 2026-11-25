import { createServer } from 'node:http';
import { config } from './config.mjs';
createServer((_, res) => res.end('ok')).listen(config.port, config.host);
