export type AgentState = 'idle' | 'thinking' | 'done';

// 3-frame strip cropped from the full sheet (184×168 each) — keeps decoded RAM tiny per tab
const faces: Record<AgentState, number> = { idle: 0, thinking: 184, done: 368 };

export function Mascot({ state, size }: { state: AgentState; size: number }) {
  const scale = size / 184;

  return (
    <span
      className={`tab-agent-mascot tab-agent-mascot--${state}`}
      style={{ width: size, height: 168 * scale }}
      aria-hidden="true"
    >
      <img
        src={browser.runtime.getURL('/mascot-expressions.webp')}
        alt=""
        draggable={false}
        style={{
          width: 552 * scale,
          height: 168 * scale,
          transform: `translateX(${-faces[state] * scale}px)`,
        }}
      />
    </span>
  );
}
