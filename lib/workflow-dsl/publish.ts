/**
 * 发布版本号。
 *
 * 入参：该 flow 已有的 flow_versions.version 列表。
 * 出参：下一条快照该用的 version。
 * 步骤：没有历史则从 1 开始；否则取 max+1。
 *
 * 不拿 flows.version 直接 +1：库里默认 version=1，但可能从未插入过 flow_versions 行。
 * 若按行上的 1 再 +1，第一次发布会写成 2，和「钉死的第一版」对不上；
 * 若直接插入 1，第二次发布再读 max(versions) 才升号。
 */
export function nextPublishedVersion(existingVersions: Iterable<number>): number {
  let max = 0;
  for (const version of existingVersions) {
    if (Number.isFinite(version) && version > max) max = version;
  }
  return max + 1;
}
