import net from "node:net";

// WHATWG fetch blocked ports, mirrored from Next.js get-reserved-port.
// next dev/start refuse these, so isolated smokes must not land on them.
export const NEXT_RESERVED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

export function isNextReservedPort(port) {
  return NEXT_RESERVED_PORTS.has(Number(port));
}

export async function getNextSafeListenPort() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = await listenEphemeralPort();
    if (!isNextReservedPort(port)) return port;
  }
  throw new Error("Unable to allocate a Next.js-safe loopback port");
}

function listenEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
