import { extractPublicWebText } from "../../src/publicWeb/http.js";

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
