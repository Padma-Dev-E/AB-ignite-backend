import { buildApi } from "./app.js";
import { env } from "./config/env.js";

async function start() {
  const app = await buildApi();
  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error({ err: error }, "Fastify API failed to start");
    process.exitCode = 1;
    await app.close();
    return;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(() => { process.exitCode = 0; });
    });
  }
}

void start().catch((error) => {
  // Avoid printing startup exceptions because config/database errors may carry sensitive values.
  process.stderr.write("Fastify API startup failed. Check the server configuration.\n");
  process.exitCode = 1;
});
