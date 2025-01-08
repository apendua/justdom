export interface FieldSetup {
  key: string;
  x: number;
  y: number;
  z: number;
  mine: boolean;
}

export interface FieldState {
  uncovered: boolean;
  flag: boolean;
}

export type FieldData = FieldSetup & FieldState;
