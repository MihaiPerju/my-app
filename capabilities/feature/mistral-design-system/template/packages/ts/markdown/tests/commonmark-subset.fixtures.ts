export const commonmarkSubsetFixtures = [
  {
    number: 5,
    markdown: "- foo\n\n\t\tbar\n",
    html: "<ul>\n<li>\n<p>foo</p>\n<pre><code>  bar\n</code></pre>\n</li>\n</ul>\n",
  },
  {
    number: 25,
    markdown:
      "&nbsp; &amp; &copy; &AElig; &Dcaron;\n&frac34; &HilbertSpace; &DifferentialD;\n&ClockwiseContourIntegral; &ngE;\n",
    html: "<p>\u00a0 &amp; \u00a9 \u00c6 \u010e\n\u00be \u210b \u2146\n\u2232 \u2267\u0338</p>\n",
  },
  {
    number: 21,
    markdown: '<a href="/bar\\/)">\n',
    html: '<a href="/bar\\/)">\n',
  },
  {
    number: 24,
    markdown: "``` foo\\+bar\nfoo\n```\n",
    html: '<pre><code class="language-foo+bar">foo\n</code></pre>\n',
  },
  {
    number: 25,
    markdown:
      "&nbsp; &amp; &copy; &AElig; &Dcaron;\n&frac34; &HilbertSpace; &DifferentialD;\n&ClockwiseContourIntegral; &ngE;\n",
    html: "<p>\u00A0 &amp; © Æ Ď\n¾ ℋ ⅆ\n∲ ≧̸</p>\n",
  },
  {
    number: 32,
    markdown: '[foo](/f&ouml;&ouml; "f&ouml;&ouml;")\n',
    html: '<p><a href="/f%C3%B6%C3%B6" title="föö">foo</a></p>\n',
  },
  {
    number: 34,
    markdown: "``` f&ouml;&ouml;\nfoo\n```\n",
    html: '<pre><code class="language-föö">foo\n</code></pre>\n',
  },
  {
    number: 43,
    markdown: "***\n---\n___\n",
    html: "<hr />\n<hr />\n<hr />\n",
  },
  {
    number: 48,
    markdown: "    ***\n",
    html: "<pre><code>***\n</code></pre>\n",
  },
  {
    number: 49,
    markdown: "Foo\n    ***\n",
    html: "<p>Foo\n***</p>\n",
  },
  {
    number: 51,
    markdown: " - - -\n",
    html: "<hr />\n",
  },
  {
    number: 56,
    markdown: " *-*\n",
    html: "<p><em>-</em></p>\n",
  },
  {
    number: 57,
    markdown: "- foo\n***\n- bar\n",
    html: "<ul>\n<li>foo</li>\n</ul>\n<hr />\n<ul>\n<li>bar</li>\n</ul>\n",
  },
  {
    number: 59,
    markdown: "Foo\n---\nbar\n",
    html: "<h2>Foo</h2>\n<p>bar</p>\n",
  },
  {
    number: 60,
    markdown: "* Foo\n* * *\n* Bar\n",
    html: "<ul>\n<li>Foo</li>\n</ul>\n<hr />\n<ul>\n<li>Bar</li>\n</ul>\n",
  },
  {
    number: 61,
    markdown: "- Foo\n- * * *\n",
    html: "<ul>\n<li>Foo</li>\n<li>\n<hr />\n</li>\n</ul>\n",
  },
  {
    number: 62,
    markdown: "# foo\n## foo\n### foo\n#### foo\n##### foo\n###### foo\n",
    html: "<h1>foo</h1>\n<h2>foo</h2>\n<h3>foo</h3>\n<h4>foo</h4>\n<h5>foo</h5>\n<h6>foo</h6>\n",
  },
  {
    number: 64,
    markdown: "#5 bolt\n\n#hashtag\n",
    html: "<p>#5 bolt</p>\n<p>#hashtag</p>\n",
  },
  {
    number: 65,
    markdown: "\\## foo\n",
    html: "<p>## foo</p>\n",
  },
  {
    number: 66,
    markdown: "# foo *bar* \\*baz\\*\n",
    html: "<h1>foo <em>bar</em> *baz*</h1>\n",
  },
  {
    number: 67,
    markdown: "#                  foo                     \n",
    html: "<h1>foo</h1>\n",
  },
  {
    number: 69,
    markdown: "    # foo\n",
    html: "<pre><code># foo\n</code></pre>\n",
  },
  {
    number: 70,
    markdown: "foo\n    # bar\n",
    html: "<p>foo\n# bar</p>\n",
  },
  {
    number: 71,
    markdown: "## foo ##\n  ###   bar    ###\n",
    html: "<h2>foo</h2>\n<h3>bar</h3>\n",
  },
  {
    number: 75,
    markdown: "# foo#\n",
    html: "<h1>foo#</h1>\n",
  },
  {
    number: 79,
    markdown: "## \n#\n### ###\n",
    html: "<h2></h2>\n<h1></h1>\n<h3></h3>\n",
  },
  {
    number: 93,
    markdown: "> foo\nbar\n===\n",
    html: "<blockquote>\n<p>foo\nbar\n===</p>\n</blockquote>\n",
  },
  {
    number: 108,
    markdown: "  - foo\n\n    bar\n",
    html: "<ul>\n<li>\n<p>foo</p>\n<p>bar</p>\n</li>\n</ul>\n",
  },
  {
    number: 109,
    markdown: "1.  foo\n\n    - bar\n",
    html: "<ol>\n<li>\n<p>foo</p>\n<ul>\n<li>bar</li>\n</ul>\n</li>\n</ol>\n",
  },
  {
    number: 112,
    markdown: "    chunk1\n      \n      chunk2\n",
    html: "<pre><code>chunk1\n  \n  chunk2\n</code></pre>\n",
  },
  {
    number: 117,
    markdown: "\n    \n    foo\n    \n\n",
    html: "<pre><code>foo\n</code></pre>\n",
  },
  {
    number: 119,
    markdown: "```\n<\n >\n```\n",
    html: "<pre><code>&lt;\n &gt;\n</code></pre>\n",
  },
  {
    number: 120,
    markdown: "~~~\n<\n >\n~~~\n",
    html: "<pre><code>&lt;\n &gt;\n</code></pre>\n",
  },
  {
    number: 121,
    markdown: "``\nfoo\n``\n",
    html: "<p><code>foo</code></p>\n",
  },
  {
    number: 126,
    markdown: "```\n",
    html: "<pre><code></code></pre>\n",
  },
  {
    number: 130,
    markdown: "```\n```\n",
    html: "<pre><code></code></pre>\n",
  },
  {
    number: 134,
    markdown: "    ```\n    aaa\n    ```\n",
    html: "<pre><code>```\naaa\n```\n</code></pre>\n",
  },
  {
    number: 138,
    markdown: "``` ```\naaa\n",
    html: "<p><code> </code>\naaa</p>\n",
  },
  {
    number: 141,
    markdown: "foo\n---\n~~~\nbar\n~~~\n# baz\n",
    html: "<h2>foo</h2>\n<pre><code>bar\n</code></pre>\n<h1>baz</h1>\n",
  },
  {
    number: 142,
    markdown: "```ruby\ndef foo(x)\n  return 3\nend\n```\n",
    html: '<pre><code class="language-ruby">def foo(x)\n  return 3\nend\n</code></pre>\n',
  },
  {
    number: 145,
    markdown: "``` aa ```\nfoo\n",
    html: "<p><code>aa</code>\nfoo</p>\n",
  },
  {
    number: 148,
    markdown:
      "<table><tr><td>\n<pre>\n**Hello**,\n\n_world_.\n</pre>\n</td></tr></table>\n",
    html: "<table><tr><td>\n<pre>\n**Hello**,\n<p><em>world</em>.\n</pre></p>\n</td></tr></table>\n",
  },
  {
    number: 161,
    markdown: "<div></div>\n``` c\nint x = 33;\n```\n",
    html: "<div></div>\n``` c\nint x = 33;\n```\n",
  },
  {
    number: 168,
    markdown: "<del>\n\n*foo*\n\n</del>\n",
    html: "<del>\n<p><em>foo</em></p>\n</del>\n",
  },
  {
    number: 170,
    markdown: '<del\nclass="foo">\n*foo*\n</del>\n',
    html: '<p><del\nclass="foo">\n<em>foo</em>\n</del></p>\n',
  },
  {
    number: 171,
    markdown:
      '<pre language="haskell"><code>\nimport Text.HTML.TagSoup\n\nmain :: IO ()\nmain = print $ parseTags tags\n</code></pre>\nokay\n',
    html: '<pre language="haskell"><code>\nimport Text.HTML.TagSoup\n\nmain :: IO ()\nmain = print $ parseTags tags\n</code></pre>\n<p>okay</p>\n',
  },
  {
    number: 181,
    markdown: "<!-- Foo\n\nbar\n   baz -->\nokay\n",
    html: "<!-- Foo\n\nbar\n   baz -->\n<p>okay</p>\n",
  },
  {
    number: 189,
    markdown: 'Foo\n<a href="bar">\nbaz\n',
    html: '<p>Foo\n<a href="bar">\nbaz</p>\n',
  },
  {
    number: 192,
    markdown: "<table>\n\n<tr>\n\n<td>\nHi\n</td>\n\n</tr>\n\n</table>\n",
    html: "<table>\n<tr>\n<td>\nHi\n</td>\n</tr>\n</table>\n",
  },
  {
    number: 199,
    markdown: "[foo]: /url 'title\n\nwith blank line'\n\n[foo]\n",
    html: "<p>[foo]: /url 'title</p>\n<p>with blank line'</p>\n<p>[foo]</p>\n",
  },
  {
    number: 212,
    markdown: '[foo]: /url\n"title" ok\n',
    html: "<p>&quot;title&quot; ok</p>\n",
  },
  {
    number: 224,
    markdown: "  aaa\n bbb\n",
    html: "<p>aaa\nbbb</p>\n",
  },
  {
    number: 225,
    markdown:
      "aaa\n             bbb\n                                       ccc\n",
    html: "<p>aaa\nbbb\nccc</p>\n",
  },
  {
    number: 226,
    markdown: "   aaa\nbbb\n",
    html: "<p>aaa\nbbb</p>\n",
  },
  {
    number: 227,
    markdown: "    aaa\nbbb\n",
    html: "<pre><code>aaa\n</code></pre>\n<p>bbb</p>\n",
  },
  {
    number: 228,
    markdown: "aaa     \nbbb     \n",
    html: "<p>aaa<br />\nbbb</p>\n",
  },
  {
    number: 234,
    markdown: "> # Foo\n> bar\nbaz\n",
    html: "<blockquote>\n<h1>Foo</h1>\n<p>bar\nbaz</p>\n</blockquote>\n",
  },
  {
    number: 235,
    markdown: "> bar\nbaz\n> foo\n",
    html: "<blockquote>\n<p>bar\nbaz\nfoo</p>\n</blockquote>\n",
  },
  {
    number: 251,
    markdown: "> bar\n>\nbaz\n",
    html: "<blockquote>\n<p>bar</p>\n</blockquote>\n<p>baz</p>\n",
  },
  {
    number: 252,
    markdown: "> > > foo\nbar\n",
    html: "<blockquote>\n<blockquote>\n<blockquote>\n<p>foo\nbar</p>\n</blockquote>\n</blockquote>\n</blockquote>\n",
  },
  {
    number: 253,
    markdown: ">>> foo\n> bar\n>>baz\n",
    html: "<blockquote>\n<blockquote>\n<blockquote>\n<p>foo\nbar\nbaz</p>\n</blockquote>\n</blockquote>\n</blockquote>\n",
  },
  {
    number: 221,
    markdown: "aaa\n\nbbb\n",
    html: "<p>aaa</p>\n<p>bbb</p>\n",
  },
  {
    number: 223,
    markdown: "aaa\n\n\nbbb\n",
    html: "<p>aaa</p>\n<p>bbb</p>\n",
  },
  {
    number: 229,
    markdown: "  \n\naaa\n  \n\n# aaa\n\n  \n",
    html: "<p>aaa</p>\n<h1>aaa</h1>\n",
  },
  {
    number: 296,
    markdown: "- foo\n  - bar\n    - baz\n      - boo\n",
    html: "<ul>\n<li>foo\n<ul>\n<li>bar\n<ul>\n<li>baz\n<ul>\n<li>boo</li>\n</ul>\n</li>\n</ul>\n</li>\n</ul>\n</li>\n</ul>\n",
  },
  {
    number: 308,
    markdown: "- foo\n\n- bar\n\n\n- baz\n",
    html: "<ul>\n<li>\n<p>foo</p>\n</li>\n<li>\n<p>bar</p>\n</li>\n<li>\n<p>baz</p>\n</li>\n</ul>\n",
  },
  {
    number: 319,
    markdown: "- a\n- b\n\n  [ref]: /url\n- d\n",
    html: "<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n<li>\n<p>d</p>\n</li>\n</ul>\n",
  },
  {
    number: 320,
    markdown: "- a\n- ```\n  b\n\n\n  ```\n- c\n",
    html: "<ul>\n<li>a</li>\n<li>\n<pre><code>b\n\n\n</code></pre>\n</li>\n<li>c</li>\n</ul>\n",
  },
  {
    number: 327,
    markdown: "* foo\n  * bar\n\n  baz\n",
    html: "<ul>\n<li>\n<p>foo</p>\n<ul>\n<li>bar</li>\n</ul>\n<p>baz</p>\n</li>\n</ul>\n",
  },
  {
    number: 346,
    markdown: '<a href="`">`\n',
    html: '<p><a href="`">`</p>\n',
  },
  {
    number: 348,
    markdown: "<https://foo.bar.`baz>`\n",
    html: '<p><a href="https://foo.bar.%60baz">https://foo.bar.`baz</a>`</p>\n',
  },
  {
    number: 356,
    markdown: "*$*alpha.\n\n*£*bravo.\n\n*€*charlie.\n\n*𞋿*delta.\n",
    html: "<p>*$*alpha.</p>\n<p>*£*bravo.</p>\n<p>*€*charlie.</p>\n<p>*𞋿*delta.</p>\n",
  },
  {
    number: 369,
    markdown: "*foo bar\n*\n",
    html: "<p>*foo bar\n*</p>\n",
  },
  {
    number: 406,
    markdown: "*foo [bar](/url)*\n",
    html: '<p><em>foo <a href="/url">bar</a></em></p>\n',
  },
  {
    number: 413,
    markdown: "*foo**bar**baz*\n",
    html: "<p><em>foo<strong>bar</strong>baz</em></p>\n",
  },
  {
    number: 414,
    markdown: "*foo**bar*\n",
    html: "<p><em>foo**bar</em></p>\n",
  },
  {
    number: 417,
    markdown: "*foo**bar***\n",
    html: "<p><em>foo<strong>bar</strong></em></p>\n",
  },
  {
    number: 424,
    markdown: "**foo [bar](/url)**\n",
    html: '<p><strong>foo <a href="/url">bar</a></strong></p>\n',
  },
  {
    number: 431,
    markdown: "**foo*bar*baz**\n",
    html: "<p><strong>foo<em>bar</em>baz</strong></p>\n",
  },
  {
    number: 485,
    markdown: "[link](/uri)\n",
    html: '<p><a href="/uri">link</a></p>\n',
  },
  {
    number: 507,
    markdown:
      "[link](/url \"title\")\n[link](/url 'title')\n[link](/url (title))\n",
    html: '<p><a href="/url" title="title">link</a>\n<a href="/url" title="title">link</a>\n<a href="/url" title="title">link</a></p>\n',
  },
  {
    number: 504,
    markdown: "[link](foo\\bar)\n",
    html: '<p><a href="foo%5Cbar">link</a></p>\n',
  },
  {
    number: 505,
    markdown: "[link](foo%20b&auml;)\n",
    html: '<p><a href="foo%20b%C3%A4">link</a></p>\n',
  },
  {
    number: 508,
    markdown: '[link](/url "title \\"&quot;")\n',
    html: '<p><a href="/url" title="title &quot;&quot;">link</a></p>\n',
  },
  {
    number: 509,
    markdown: '[link](/url "title")\n',
    html: '<p><a href="/url%C2%A0%22title%22">link</a></p>\n',
  },
  {
    number: 520,
    markdown: "[foo [bar](/uri)](/uri)\n",
    html: '<p>[foo <a href="/uri">bar</a>](/uri)</p>\n',
  },
  {
    number: 522,
    markdown: "![[[foo](uri1)](uri2)](uri3)\n",
    html: '<p><img src="uri3" alt="[foo](uri2)" /></p>\n',
  },
  {
    number: 529,
    markdown: '[foo][bar]\n\n[bar]: /url "title"\n',
    html: '<p><a href="/url" title="title">foo</a></p>\n',
  },
  {
    number: 542,
    markdown: "[ẞ]\n\n[SS]: /url\n",
    html: '<p><a href="/url">ẞ</a></p>\n',
  },
  {
    number: 543,
    markdown: "[Foo\n  bar]: /url\n\n[Baz][Foo bar]\n",
    html: '<p><a href="/url">Baz</a></p>\n',
  },
  {
    number: 555,
    markdown: '[foo][]\n\n[foo]: /url "title"\n',
    html: '<p><a href="/url" title="title">foo</a></p>\n',
  },
  {
    number: 558,
    markdown: '[foo] \n[]\n\n[foo]: /url "title"\n',
    html: '<p><a href="/url" title="title">foo</a>\n[]</p>\n',
  },
  {
    number: 570,
    markdown: "[foo](not a link)\n\n[foo]: /url1\n",
    html: '<p><a href="/url1">foo</a>(not a link)</p>\n',
  },
  {
    number: 572,
    markdown: "[foo][bar][baz]\n\n[baz]: /url1\n[bar]: /url2\n",
    html: '<p><a href="/url2">foo</a><a href="/url1">baz</a></p>\n',
  },
  {
    number: 576,
    markdown: "![foo ![bar](/url)](/url2)\n",
    html: '<p><img src="/url2" alt="foo bar" /></p>\n',
  },
  {
    number: 596,
    markdown: "<http://foo.bar.baz>\n",
    html: '<p><a href="http://foo.bar.baz">http://foo.bar.baz</a></p>\n',
  },
  {
    number: 606,
    markdown: "<foo@bar.example.com>\n",
    html: '<p><a href="mailto:foo@bar.example.com">foo@bar.example.com</a></p>\n',
  },
  {
    number: 615,
    markdown: "<a><bab><c2c>\n",
    html: "<p><a><bab><c2c></p>\n",
  },
  {
    number: 619,
    markdown: 'Foo <responsive-image src="foo.jpg" />\n',
    html: '<p>Foo <responsive-image src="foo.jpg" /></p>\n',
  },
  {
    number: 628,
    markdown: "foo <!--> foo -->\n\nfoo <!---> foo -->\n",
    html: "<p>foo <!--> foo --&gt;</p>\n<p>foo <!---> foo --&gt;</p>\n",
  },
  {
    number: 652,
    markdown: "foo \n baz\n",
    html: "<p>foo\nbaz</p>\n",
  },
] as const;
