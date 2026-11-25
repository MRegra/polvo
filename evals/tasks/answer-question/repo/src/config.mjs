const defaults = { host: '0.0.0.0', port: 8137, workers: 4 };
export const config = {
  ...defaults,
  port: Number(process.env.APP_PORT ?? defaults.port),
};
