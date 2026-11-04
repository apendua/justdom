import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, useFrame } from "@react-three/fiber";

function Cube() {
  const ref = useRef();
  useFrame(() => {
    ref.current.rotation.y += 0.01;
  });
  return (
    <mesh ref={ref}>
      <boxGeometry />
      <meshStandardMaterial />
    </mesh>
  );
}

createRoot(document.querySelector("#app")).render(
  <Canvas>
    <ambientLight intensity={1} />
    <Cube />
  </Canvas>,
);
