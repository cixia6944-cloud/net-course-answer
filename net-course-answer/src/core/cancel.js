// 可中断任务的取消令牌。
// 用途: 一轮答题(取答案/回填)或一轮刷课各持一个令牌 —— 停止只打断自己的那一轮,
// 不会误伤后开的任务; 循环在每一题/每个任务点前查一次 token.stopped 就够。
// 之所以单独成模块: 取消语义是纯逻辑, 想在 node 里直接测(见 tools/cancel-test.mjs)。
export function createCancelToken() {
  const state = { stopped: false, running: false };
  return {
    get stopped() {
      return state.stopped;
    },
    get running() {
      return state.running;
    },
    /** 开始一轮(清掉上一轮的停止标记) */
    begin() {
      state.stopped = false;
      state.running = true;
      return this;
    },
    /** 请求停止: 第一次返回 true(真的打断了), 重复调用返回 false(避免日志刷屏) */
    request() {
      if (!state.running || state.stopped) return false;
      state.stopped = true;
      return true;
    },
    /** 本轮结束(正常跑完或被停止) */
    done() {
      state.running = false;
      return this;
    },
  };
}
