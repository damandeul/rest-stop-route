import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const artifacts = join(process.cwd(), 'artifacts');

async function chooseReferencePlace(page) {
  await page.getByLabel('주소나 쉼터명으로 기준 장소 찾기').fill('휴서울이동노동자북창쉼터');
  await page.getByRole('option', { name: /휴서울이동노동자북창쉼터/ }).click();
}

test('390px 핵심 3화면 스크린샷 생성', async ({ page }) => {
  await mkdir(artifacts, { recursive: true });
  await page.goto('/');
  await page.screenshot({ path: join(artifacts, '01-input-390.png'), fullPage: true });

  await chooseReferencePlace(page);
  await page.getByRole('button', { name: '주변 쉼터 보기' }).click();
  await expect(page.locator('[data-shelter-id]').first()).toBeVisible();
  await page.screenshot({ path: join(artifacts, '02-result-390.png'), fullPage: true });

  await page.locator('[data-shelter-id]').first().getByText('출처와 제한 사유 보기').click();
  await page.screenshot({ path: join(artifacts, '03-detail-390.png'), fullPage: true });
});
