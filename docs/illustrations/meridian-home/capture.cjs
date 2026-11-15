const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:5288/?capture=meridian-home');
  await page.waitForSelector('.ss-stage');
  await page.waitForTimeout(1500);
  // Let the page around the stage be transparent, so the rounded corners are too.
  await page.addStyleTag({ content: 'html, body, #root, #example { background: transparent !important; }' });
  const box = await page.locator('.ss-stage').boundingBox();
  await page.screenshot({ path: process.argv[2], clip: box, omitBackground: true });
  console.log(JSON.stringify(box));
  await browser.close();
})();
