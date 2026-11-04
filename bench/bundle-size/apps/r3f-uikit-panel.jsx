import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas } from "@react-three/fiber";
import { Container, Text } from "@react-three/uikit";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <group position={[0, 0, -2]}>
      <Container padding={12} backgroundColor="#eee" onClick={() => setCount(count + 1)}>
        <Text>Clicked {count} times</Text>
      </Container>
    </group>
  );
}

createRoot(document.querySelector("#app")).render(
  <Canvas>
    <Counter />
  </Canvas>,
);
