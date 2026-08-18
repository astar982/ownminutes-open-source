export async function waitForHostPostgres(databaseUrl, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 60;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 500;
  const { Client } = await import("pg");
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {}
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  const errorCode = typeof lastError?.code === "string" ? ` (${lastError.code})` : "";
  throw new Error(`Disposable PostgreSQL host port did not become ready${errorCode}.`);
}
