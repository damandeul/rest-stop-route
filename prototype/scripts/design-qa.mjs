import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const baseURL = 'http://127.0.0.1:4173';
const artifactDir = new URL('../artifacts/', import.meta.url);
await fs.mkdir(artifactDir, { recursive: true });

async function chooseReferencePlace(page) {
  const input = page.getByLabel('주소나 쉼터명으로 기준 장소 찾기');
  await input.fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
}

async function metrics(page, screen) {
  return page.evaluate((screenName) => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right > root.clientWidth + 1 || rect.left < -1;
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      .slice(0, 20);
    const undersized = [...document.querySelectorAll('button, input, a, summary')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((element) => ({
        tag: element.tagName,
        text: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 50),
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      }));
    return {
      screen: screenName,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: root.scrollWidth,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      overflowOffenders: offenders,
      undersizedTargets: undersized,
    };
  }, screen);
}

const browser = await chromium.launch({ headless: true });
const report = {
  checkedAt: new Date().toISOString(),
  flow: 'direct-search-to-official-results',
  viewports: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
};

for (const width of [390, 768, 1024, 1440]) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push({ width, text: message.text() });
  });
  page.on('pageerror', (error) => report.pageErrors.push({ width, text: error.message }));
  page.on('requestfailed', (request) => {
    report.failedRequests.push({ width, url: request.url(), error: request.failure()?.errorText });
  });

  await page.goto(baseURL, { waitUntil: 'networkidle' });
  report.viewports.push(await metrics(page, 'search'));
  if (width === 390) {
    await page.screenshot({ path: new URL('01-input-390.png', artifactDir).pathname, fullPage: true });
  }

  await chooseReferencePlace(page);
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await page.locator('[data-shelter-id]').first().waitFor();
  report.viewports.push(await metrics(page, 'official-results'));
  if (width === 390) {
    await page.screenshot({ path: new URL('02-result-390.png', artifactDir).pathname, fullPage: true });
  }

  await page.getByText('출처와 제한 사유 보기').first().click();
  report.viewports.push(await metrics(page, 'source-detail-open'));
  if (width === 390) {
    await page.screenshot({ path: new URL('03-detail-390.png', artifactDir).pathname, fullPage: true });
  }

  await context.close();
}

const zoomContext = await browser.newContext({ viewport: { width: 195, height: 422 }, reducedMotion: 'reduce' });
const zoomPage = await zoomContext.newPage();
zoomPage.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors.push({ width: 195, text: message.text() });
});
zoomPage.on('pageerror', (error) => report.pageErrors.push({ width: 195, text: error.message }));
zoomPage.on('requestfailed', (request) => {
  report.failedRequests.push({ width: 195, url: request.url(), error: request.failure()?.errorText });
});
report.zoom200 = [];
await zoomPage.goto(baseURL, { waitUntil: 'networkidle' });
report.zoom200.push(await metrics(zoomPage, 'search-200-percent-zoom'));
await chooseReferencePlace(zoomPage);
await zoomPage.getByRole('button', { name: '주변 쉼터 보기' }).click();
await zoomPage.locator('[data-shelter-id]').first().waitFor();
report.zoom200.push(await metrics(zoomPage, 'official-results-200-percent-zoom'));
await zoomPage.getByText('출처와 제한 사유 보기').first().click();
report.zoom200.push(await metrics(zoomPage, 'source-detail-open-200-percent-zoom'));
await zoomContext.close();
await browser.close();

const metricsPass = (item) => (
  item.horizontalOverflow === 0
  && item.overflowOffenders.length === 0
  && item.undersizedTargets.length === 0
);
report.pass = report.viewports.every(metricsPass)
  && report.zoom200.every(metricsPass)
  && report.consoleErrors.length === 0
  && report.pageErrors.length === 0
  && report.failedRequests.length === 0;

await fs.writeFile(new URL('design-qa.json', artifactDir), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
