try {
  const target = process.argv[2] === "api"
    ? "http://127.0.0.1:4100/health/ready"
    : "http://127.0.0.1:3000/login";
  const response = await fetch(target, {
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
