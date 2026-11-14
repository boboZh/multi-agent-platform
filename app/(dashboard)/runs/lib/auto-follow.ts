type ScrollPosition = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * 入参：当前跟随开关、上次滚动位置及本次容器尺寸。出参：下一次跟随开关。
 * 上滑优先暂停；向下回到距底部 8px 内才恢复。内容增长本身不能把跟随状态关闭。
 * 允许浏览器的亚像素位置，忽略 1px 内抖动；无效尺寸不改变用户的选择。
 */
export function nextAutoFollow(
  following: boolean,
  previousTop: number,
  { scrollTop, scrollHeight, clientHeight }: ScrollPosition,
): boolean {
  if (![previousTop, scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) {
    return following;
  }
  if (scrollHeight < 0 || clientHeight < 0) return following;
  const top = Math.max(0, scrollTop);
  if (top < Math.max(0, previousTop) - 1) return false;
  if (scrollHeight - clientHeight - top <= 8) return true;
  return following;
}
