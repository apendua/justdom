import { batch, createProperty, memo, store } from "justdom-signal";
import { BBox, VectorLike, createRect, getFieldSetBBox, getNeighbors } from "@apendua/geometry";
import type { FieldData, FieldState, FieldSetup } from "./types";

export * from "./types";

interface GenerateFieldsOptions {
  nRows?: number;
  nColumns?: number;
  minesRatio?: number;
}

export function getKey({ x, y, z }: VectorLike): string {
  return `${x},${y},${z}`;
}

export class Field {
  #state: FieldState;
  #fields: Fields;
  #fieldSetup: FieldSetup;

  public constructor(props: FieldData, fields: Fields) {
    const { uncovered, flag, ...fieldSetup } = props;
    this.#state = store({
      uncovered,
      flag,
    });
    this.#fields = fields;
    this.#fieldSetup = fieldSetup;
  }

  public get key(): string {
    return this.#fieldSetup.key;
  }

  public get mine(): boolean {
    return this.#fieldSetup.mine;
  }

  public get uncovered(): boolean {
    return this.#state.uncovered;
  }

  public get flag(): boolean {
    return this.#state.flag;
  }

  public get x(): number {
    return this.#fieldSetup.x;
  }

  public get y(): number {
    return this.#fieldSetup.y;
  }

  public get z(): number {
    return this.#fieldSetup.z;
  }

  @memo()
  public get neighbors(): Field[] {
    return getNeighbors(this.#fieldSetup).flatMap((vector) => {
      const neighborKey = getKey(vector);
      const neighbor = this.#fields.getField(neighborKey);
      return neighbor ? [neighbor] : [];
    });
  }

  public get nMines(): number {
    return this.neighbors.filter((neighbor) => neighbor.mine).length;
  }

  public get statusText(): string {
    if (!this.uncovered) {
      if (this.flag) {
        return "?";
      }
      return "";
    }
    if (this.mine) {
      return "X";
    }
    if (this.nMines > 0) {
      return `${this.nMines}`;
    }
    return "";
  }

  public uncover(): void {
    batch(() => {
      if (this.#state.uncovered || this.#state.flag || this.#fields.isGameOver) {
        return;
      }
      this.#state.uncovered = true;
      if (this.mine) {
        this.#fields.revealMines();
      } else if (this.nMines === 0) {
        this.neighbors.forEach((neighbor) => neighbor.uncover());
      }
    });
  }

  public reveal(): void {
    this.#state.uncovered = true;
  }

  public toggleFlag(): void {
    if (this.#fields.isGameOver || this.#state.uncovered) {
      return;
    }
    this.#state.flag = !this.#state.flag;
  }
}

export class Fields {
  #state: { keys: string[] };
  #fields: Map<string, Field> = new Map();

  public constructor(fields: Record<string, FieldSetup>) {
    this.#state = store({ keys: Object.keys(fields) });
    for (const [key, field] of Object.entries(fields)) {
      const fieldData: FieldData = {
        ...field,
        uncovered: false,
        flag: false,
      };
      this.#fields.set(key, new Field(fieldData, this));
    }
  }

  public getField(key: string): Field | undefined {
    return this.#fields.get(key);
  }

  public get fieldKeys(): string[] {
    return [...this.#state.keys];
  }

  @memo()
  public get coveredFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && !field.uncovered ? [field] : [];
    });
  }

  @memo()
  public get totalMines(): number {
    return this.fieldKeys.filter((key) => {
      const field = this.getField(key);
      return field && field.mine;
    }).length;
  }

  @memo()
  public get uncoveredFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && field.uncovered ? [field] : [];
    });
  }

  @memo()
  public get flaggedFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && field.flag ? [field] : [];
    });
  }

  public get numberOfCoveredMines(): number {
    return this.uncoveredFields.filter((field) => field.mine).length;
  }

  public get minesLeft(): number {
    return this.totalMines - this.flaggedFields.length;
  }

  @memo()
  public get isLost(): boolean {
    return this.uncoveredFields.some((field) => field.mine);
  }

  @memo()
  public get isWon(): boolean {
    return (
      !this.isLost &&
      this.uncoveredFields.length > 0 &&
      this.coveredFields.length === this.totalMines
    );
  }

  public get isGameOver(): boolean {
    return this.isWon || this.isLost;
  }

  public revealMines(): void {
    batch(() => {
      for (const field of this.allFields) {
        if (field.mine) {
          field.reveal();
        }
      }
    });
  }

  public get allFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field ? [field] : [];
    });
  }

  public get bounds(): BBox {
    return getFieldSetBBox(this.allFields);
  }

  public static generate(options: GenerateFieldsOptions) {
    const { nRows = 15, nColumns = 15, minesRatio = 0.2 } = options;
    const fields: Record<string, FieldSetup> = {};
    const vectors = createRect({ nRows, nColumns });
    for (const v of vectors) {
      const key = getKey(v);
      fields[key] = {
        ...v,
        key,
        mine: Math.random() < minesRatio,
      };
    }
    return new this(fields);
  }
}

export const FieldsContext = createProperty<Fields>(() => new Fields({}));
