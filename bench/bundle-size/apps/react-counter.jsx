import { useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button className="counter" onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  );
}

createRoot(document.querySelector("#app")).render(<Counter />);
