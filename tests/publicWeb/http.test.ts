import { connect, createServer, type AddressInfo } from "node:net";
import {
  PublicWebFetchError,
  assertSubstantialHtmlExtraction,
  extractPublicWebText,
  pinnedAddressLookup,
} from "../../src/publicWeb/http.js";

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

test("extracts readable HTML text without executable document content", () => {
  expect(
    extractPublicWebText(
      "<html><head><title>Example &amp; Co</title><style>.x { color: red }</style></head>" +
        "<body><script>alert('no')</script><h1>Hello&nbsp;world</h1><p>One &lt; two.</p>" +
        "<template>also ignore</template><div>Final line</div></body></html>",
    ),
  ).toEqual({
    title: "Example & Co",
    text: "Example & Co\nHello world\nOne < two.\nFinal line",
  });
});

test("keeps noscript fallback content: this reader never executes JavaScript", () => {
  expect(
    extractPublicWebText(
      "<html><body><noscript><p>Fallback article body</p></noscript>" +
        "<div>Visible line</div></body></html>",
    ),
  ).toEqual({
    title: undefined,
    text: "Fallback article body\nVisible line",
  });
});

test("tolerates '>' inside quoted attribute values instead of leaking tag fragments", () => {
  expect(
    extractPublicWebText(
      '<html><head><link media="(width >= 40rem)" rel="stylesheet" data-target="desktop" /></head>' +
        '<body><div data-note="a > b">Real content</div></body></html>',
    ),
  ).toEqual({ title: undefined, text: "Real content" });
});

test("keeps plain text as normalized text", () => {
  expect(extractPublicWebText("  first\n\n second\tline  ")).toEqual({
    title: undefined,
    text: "first\nsecond line",
  });
});

test("rejects an HTML extraction that is both tiny and a sliver of the document", () => {
  expect(() =>
    assertSubstantialHtmlExtraction("x".repeat(246), "a".repeat(31_523), {
      url: "https://example.test/js-only-page",
    }),
  ).toThrow(PublicWebFetchError);
  expect(() =>
    assertSubstantialHtmlExtraction("x".repeat(246), "a".repeat(31_523), {}),
  ).toThrow(/almost no text/);
});

test("keeps a small extraction from a small page: proportionate text is real content", () => {
  expect(() =>
    assertSubstantialHtmlExtraction("x".repeat(300), "a".repeat(800), {}),
  ).not.toThrow();
});

test("keeps a sparse extraction that still clears the absolute text floor", () => {
  expect(() =>
    assertSubstantialHtmlExtraction("x".repeat(500), "a".repeat(100_000), {}),
  ).not.toThrow();
});
