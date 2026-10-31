/**
 * How a field of the hex grid maps onto the svg canvas. Every component that
 * draws something on the board needs it.
 */
export interface Dimensions {
  fieldWidth: number;
  fieldHeight: number;
  offsetX: number;
  offsetY: number;
}
