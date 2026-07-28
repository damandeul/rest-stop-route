import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

async function choosePlace(page, field, query, resultName) {
  await page.getByLabel(field).fill(query);
  await page.getByRole('button', { name: new RegExp(resultName) }).click();
}

test('390px 핵심 3화면 스크린샷 생성', async ({ page }) => {
  await fs.mkdir('artifacts', { recursive: true });
  await page.goto('/');
  await page.screenshot({ path: 'artifacts/01-input-390.png', fullPage: true });

  await choosePlace(page, '출발지', '서울', '서울시청');
  await choosePlace(page, '목적지', '서울', '서울도서관');
  await page.getByRole('radio', { name: '5분' }).click();
  await page.getByRole('checkbox', { name: '냉방 실내' }).click();
  await page.getByRole('checkbox', { name: '화장실' }).click();
  await page.getByRole('button', { name: '휴식 후보 이어보기' }).click();
  await expect(page.getByRole('heading', { name: '연결 결과' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/02-result-390.png', fullPage: true });

  await page.getByRole('button', { name: /한빛 무더위쉼터 상세 보기/ }).click();
  await expect(page.getByRole('heading', { name: '한빛 무더위쉼터' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/03-detail-390.png', fullPage: true });
});
