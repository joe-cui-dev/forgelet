import { connect, createServer, type AddressInfo } from "node:net";
import { extractPublicWebText, pinnedAddressLookup } from "../../src/publicWeb/http.js";

test("pinned lookup connects through Node's autoSelectFamily socket path", async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({
        host: "pinned-lookup.invalid",
        port,
        lookup: pinnedAddressLookup([{ address: "127.0.0.1", family: 4 }]),
        autoSelectFamily: true,
      });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pinned lookup returns the address array only when Node asks for all addresses", () => {
  const lookup = pinnedAddressLookup([{ address: "203.0.113.7", family: 4 }]);
  const seen: unknown[][] = [];
  lookup("pinned-lookup.invalid", { all: true }, (...args) => seen.push(args));
  lookup("pinned-lookup.invalid", {}, (...args) => seen.push(args));
  expect(seen).toEqual([
    [null, [{ address: "203.0.113.7", family: 4 }]],
    [null, "203.0.113.7", 4],
  ]);
});

test("extracts readable HTML text without executable or hidden document content", () => {
  expect(
    extractPublicWebText(
      "<html><head><title>Example &amp; Co</title><style>.x { color: red }</style></head>" +
        "<body><script>alert('no')</script><h1>Hello&nbsp;world</h1><p>One &lt; two.</p>" +
        "<noscript>ignore</noscript><template>also ignore</template><div>Final line</div></body></html>",
    ),
  ).toEqual({
    title: "Example & Co",
    text: "Example & Co\nHello world\nOne < two.\nFinal line",
  });
});

test("keeps plain text as normalized text", () => {
  expect(extractPublicWebText("  first\n\n second\tline  ")).toEqual({
    title: undefined,
    text: "first\nsecond line",
  });
});
