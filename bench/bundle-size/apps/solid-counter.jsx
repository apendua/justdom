import { createSignal } from "solid-js";
import { render } from "solid-js/web";

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button class="counter" onClick={() => setCount(count() + 1)}>
      Clicked {count()} times
    </button>
  );
}

render(() => <Counter />, document.querySelector("#app"));
