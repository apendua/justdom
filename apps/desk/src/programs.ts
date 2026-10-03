/**
 * What the disks hold. The monitor boots `DESK.JS`, and each floppy on the
 * desk is labelled with one of the others.
 */
export const PROGRAMS: Readonly<Record<string, string>> = {
  "DESK.JS": `// desk.js - everything on this desk is a <div>
import { dom, render } from "@apendua/freedom";

const things = ["charts", "monitor", "board", "memo"];

const Desk = (ctx) =>
  things.map((id) =>
    dom(ctx, document.getElementById(id), [
      set({ position: place(id) }),
    ], { draggable: id !== "monitor" }),
  );

render(Desk);`,
  "PLOT.BAS": `10 REM PLOT THE QUARTER
20 DIM S(12)
30 FOR I = 1 TO 12
40   S(I) = 50 + 30 * SIN(I / 2)
50   PLOT I * 20, 200 - S(I)
60 NEXT I
70 PRINT "REVENUE UP"; S(12) - S(1); "%"
80 GOTO 10`,
  "SNAKE.ASM": `; snake.asm - 6502, 40 columns
        LDX #$00
loop:   LDA head,X      ; next segment
        STA $0400,X     ; onto the screen
        INX
        CPX #$28
        BNE loop
        JSR waitkey
        JMP loop`,
  "REVEAL.FRAG": `// reveal.frag - how this screen types
uniform vec4 uCut;   // line, x, top, bottom
in float vLine;
in float vX;

void main() {
  if (vLine > uCut.x) discard;
  if (vLine == uCut.x && vX > uCut.y) discard;
  fragColor = texture(uGlyphs, vUv) * uColor;
}`,
};
