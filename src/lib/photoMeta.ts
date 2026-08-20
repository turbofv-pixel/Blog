// 사진이 실제로 찍힌 시각을 알아내서 캡션과 함께 올린다. 파일명(예: 1000024361.jpg)은
// 안드로이드 MediaStore의 일련번호 방식이라 시간 정보가 없는 경우가 많아서, 파일명 대신
// JPEG의 EXIF DateTimeOriginal(태그 0x9003, 없으면 DateTimeDigitized 0x9004, 그것도 없으면
// IFD0의 DateTime 0x0132)을 직접 파싱한다. 서버/라이브러리 없이 File의 앞부분 바이트만
// 읽어서 브라우저 안에서 처리 — 다른 EXIF 라이브러리를 새로 추가하지 않기 위해 필요한 만큼만
// 직접 구현했다.
//
// EXIF가 아예 없는 파일(스크린샷, 편집/공유 과정에서 메타데이터가 지워진 사진, PNG 등)은
// File.lastModified로 대체하되, 그건 "촬영 시각"이 아니라 "파일이 마지막으로 손댄 시각"이라
// 부정확할 수 있어서 source를 구분해서 반환한다.

export type PhotoTimestamp = { date: Date; source: 'exif' | 'file-modified' } | null;

type IfdEntry = { formatCode: number; count: number; valueOffset: number };

function readIfdEntries(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>();
  const headerOffset = tiffStart + ifdOffset;
  if (headerOffset + 2 > view.byteLength) return entries;
  const numEntries = view.getUint16(headerOffset, little);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = headerOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, little);
    const formatCode = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    entries.set(tag, { formatCode, count, valueOffset: entryOffset + 8 });
  }
  return entries;
}

function readAsciiValue(view: DataView, tiffStart: number, entry: IfdEntry, little: boolean): string | null {
  if (entry.formatCode !== 2) return null; // 2 = ASCII
  let dataOffset = entry.valueOffset;
  if (entry.count > 4) {
    dataOffset = tiffStart + view.getUint32(entry.valueOffset, little);
  }
  if (dataOffset < 0 || dataOffset + entry.count > view.byteLength) return null;
  const bytes: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const b = view.getUint8(dataOffset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes);
}

function parseExifDate(str: string): Date | null {
  // EXIF 날짜 형식: "YYYY:MM:DD HH:MM:SS"
  const m = str.trim().match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 이미 메모리에 읽어둔 버퍼(원본 File 전체 또는 그 앞부분)에서 EXIF를 파싱한다 — 원본 File을
// 다시 건드리지 않는다(구글 포토 등에서 받은 파일은 File을 두 번째로 건드리면 실패하는 게
// 확인됐다).
function readExifDateTimeFromBuffer(buf: ArrayBuffer): Date | null {
  try {
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // JPEG(SOI)가 아님

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break; // 마커가 아닌 데이터 — 더 볼 필요 없음
      if (marker === 0xffd8) {
        offset += 2;
        continue;
      }
      if (marker === 0xffda) break; // SOS(스캔 시작) — EXIF는 그 전에 있어야 함

      const segLength = view.getUint16(offset + 2);
      if (marker === 0xffe1 && segLength >= 8) {
        const segStart = offset + 4;
        if (
          segStart + 6 <= view.byteLength &&
          view.getUint32(segStart) === 0x45786966 && // 'Exif'
          view.getUint16(segStart + 4) === 0x0000
        ) {
          const tiffStart = segStart + 6;
          if (tiffStart + 8 <= view.byteLength) {
            const byteOrder = view.getUint16(tiffStart);
            const little = byteOrder === 0x4949; // 'II'
            if (little || byteOrder === 0x4d4d) {
              const firstIfdOffset = view.getUint32(tiffStart + 4, little);
              const ifd0 = readIfdEntries(view, tiffStart, firstIfdOffset, little);

              // 1순위: Exif 서브 IFD 안의 DateTimeOriginal/DateTimeDigitized
              const exifIfdPtr = ifd0.get(0x8769);
              if (exifIfdPtr) {
                const exifIfdOffset = view.getUint32(exifIfdPtr.valueOffset, little);
                const exifIfd = readIfdEntries(view, tiffStart, exifIfdOffset, little);
                const dtoEntry = exifIfd.get(0x9003) || exifIfd.get(0x9004);
                if (dtoEntry) {
                  const str = readAsciiValue(view, tiffStart, dtoEntry, little);
                  const parsed = str ? parseExifDate(str) : null;
                  if (parsed) return parsed;
                }
              }
              // 2순위: IFD0의 DateTime
              const dtEntry = ifd0.get(0x0132);
              if (dtEntry) {
                const str = readAsciiValue(view, tiffStart, dtEntry, little);
                const parsed = str ? parseExifDate(str) : null;
                if (parsed) return parsed;
              }
            }
          }
        }
      }
      offset += 2 + segLength;
    }
  } catch {
    // 파싱 중 어디서든 실패하면 EXIF 없음으로 취급 — 사진 자체 처리에는 지장 없게 한다.
  }
  return null;
}

// 이미 메모리에 읽어둔 버퍼로부터 촬영 시각을 알아낸다 — 원본 File을 다시 읽지 않는다.
// 호출한 쪽(GithubPhotoUploader)이 File을 딱 한 번 읽어서 이 버퍼를 캐싱해두고, 이미지
// 리사이즈와 이 함수 양쪽에 재사용한다.
export function getPhotoTimestampFromBuffer(buf: ArrayBuffer, fallbackLastModifiedMs?: number): PhotoTimestamp {
  const exifDate = readExifDateTimeFromBuffer(buf);
  if (exifDate) return { date: exifDate, source: 'exif' };
  if (fallbackLastModifiedMs) {
    return { date: new Date(fallbackLastModifiedMs), source: 'file-modified' };
  }
  return null;
}

// 원본 File을 직접 받아 처리하는 예전 방식 — 호출한 쪽에서 버퍼를 미리 캐싱해두지 못한
// 경우(예: 격리된 단독 호출)를 위한 편의 함수.
export async function getPhotoTimestamp(file: File): Promise<PhotoTimestamp> {
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  return getPhotoTimestampFromBuffer(buf, file.lastModified);
}

// 사람이 읽기 좋은 "2026-08-08 15:44" 형식으로 포맷 (초 단위는 캡션 용도로는 불필요).
export function formatPhotoTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
