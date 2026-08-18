#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import sharp from "sharp";

const appIconSourcePath = "apps/mobile/assets/icon-appstore-source.png";
const auxiliarySourcePath = "apps/mobile/assets/icon-source.svg";
const [appIconSource, source] = await Promise.all([
  readFile(appIconSourcePath),
  readFile(auxiliarySourcePath),
]);
const transparentSource = source
  .toString("utf8")
  .replace('<rect width="1024" height="1024" fill="#0D3B31"/>', "");
const monochromeSource = transparentSource
  .replaceAll("#176B59", "#FFFFFF")
  .replaceAll("#F2B84B", "#FFFFFF")
  .replaceAll("#77D5B5", "#FFFFFF");
const appIcon = await createFullBleedAppIcon(appIconSource);

await Promise.all([
  sharp(appIcon).png().toFile("apps/mobile/assets/icon.png"),
  sharp(Buffer.from(transparentSource)).resize(1024, 1024).png().toFile("apps/mobile/assets/splash-icon.png"),
  sharp(source).resize(48, 48).flatten({ background: "#0D3B31" }).removeAlpha().png().toFile("apps/mobile/assets/favicon.png"),
  sharp(Buffer.from(transparentSource), { density: 144 }).resize(512, 512, { fit: "contain" }).png().toFile("apps/mobile/assets/android-icon-foreground.png"),
  sharp({ create: { width: 512, height: 512, channels: 4, background: "#0D3B31" } }).png().toFile("apps/mobile/assets/android-icon-background.png"),
  sharp(Buffer.from(monochromeSource), { density: 144 }).resize(432, 432, { fit: "contain" }).png().toFile("apps/mobile/assets/android-icon-monochrome.png"),
]);

console.log(JSON.stringify({
  generated: true,
  appIconSource: appIconSourcePath,
  auxiliarySource: auxiliarySourcePath,
  brand: "OwnMinutes",
}, null, 2));

async function createFullBleedAppIcon(input) {
  const { data, info } = await sharp(input)
    .resize(1024, 1024, { fit: "cover" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cornerLimit = Math.round(Math.min(info.width, info.height) * 0.3);
  const roundedCanvasRadius = Math.round(Math.min(info.width, info.height) * 0.22);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const inCorner =
        (x < cornerLimit || x >= info.width - cornerLimit) &&
        (y < cornerLimit || y >= info.height - cornerLimit);
      if (!inCorner) continue;

      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const minimum = Math.min(red, green, blue);
      const maximum = Math.max(red, green, blue);
      const neutralWeight = clamp((28 - (maximum - minimum)) / 28);
      const lightWeight = clamp((minimum - 150) / 105);
      const cornerX = Math.min(x, info.width - 1 - x);
      const cornerY = Math.min(y, info.height - 1 - y);
      const roundedCanvasDistance = Math.hypot(
        roundedCanvasRadius - cornerX,
        roundedCanvasRadius - cornerY,
      );
      const roundedCanvasWeight =
        cornerX < roundedCanvasRadius && cornerY < roundedCanvasRadius
          ? clamp((roundedCanvasDistance - (roundedCanvasRadius - 8)) / 10)
          : 0;
      const replacementWeight = Math.max(roundedCanvasWeight, neutralWeight * lightWeight);
      if (replacementWeight <= 0) continue;

      const background = appIconBackgroundAt(x, y, info.width, info.height);
      data[offset] = blend(red, background[0], replacementWeight);
      data[offset + 1] = blend(green, background[1], replacementWeight);
      data[offset + 2] = blend(blue, background[2], replacementWeight);
    }
  }

  return sharp(data, { raw: info }).removeAlpha().png().toBuffer();
}

function appIconBackgroundAt(x, y, width, height) {
  const horizontal = x / Math.max(1, width - 1);
  const vertical = y / Math.max(1, height - 1);
  const top = interpolate([0, 82, 78], [0, 62, 65], horizontal);
  const bottom = interpolate([0, 66, 63], [0, 61, 54], horizontal);
  return interpolate(top, bottom, vertical);
}

function interpolate(from, to, amount) {
  return from.map((value, index) => Math.round(value + (to[index] - value) * amount));
}

function blend(from, to, amount) {
  return Math.round(from + (to - from) * amount);
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}
