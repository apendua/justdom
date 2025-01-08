import { merge, NEVER, Observable, switchMap } from "rxjs";
import {
  $watch,
  $observe,
  dependencies,
  invalidate,
  Store,
} from "@apendua.dev/store4";
import { createProperty } from "@apendua.dev/context";
import {
  BBox,
  VectorLike,
  createRect,
  getFieldSetBBox,
  getNeighbors,
} from "@apendua.dev/geometry";
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

export class Field extends Store<FieldState> {
  #fields: Fields;
  #fieldSetup: FieldSetup;

  public constructor(props: FieldData, fields: Fields) {
    const { uncovered, flag, ...fieldSetup } = props;
    super({
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

  @Field.state("uncovered")
  public get uncovered(): boolean {
    return this.state.uncovered;
  }

  // @Field.state("flag")
  @invalidate(function () {
    return $watch(this.state).flag;
  })
  public get flag(): boolean {
    return this.state.flag;
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

  @dependencies()
  public get neighbors(): Field[] {
    return getNeighbors(this.#fieldSetup).flatMap((vector) => {
      const neighborKey = getKey(vector);
      const neighbor = this.#fields.getField(neighborKey);
      return neighbor ? [neighbor] : [];
    });
  }

  @dependencies("neighbors")
  public get nMines(): number {
    return this.neighbors.filter((neighbor) => neighbor.mine).length;
  }

  @dependencies("flag", "mine", "uncovered", "nMines")
  public get statusText(): string {
    if (!this.uncovered) {
      if (this.flag) {
        return "🚩";
      }
      return "";
    }
    if (this.mine) {
      return "💥";
    }
    if (this.nMines > 0) {
      return `${this.nMines}`;
    }
    return "";
  }

  public uncover(): void {
    if (this.uncovered) {
      return;
    }
    this.mutate((state) => {
      state.uncovered = true;
    });
    if (this.nMines === 0) {
      this.neighbors.forEach((neighbor) => neighbor.uncover());
    }
  }

  public toggleFlag(): void {
    this.mutate((state) => {
      state.flag = !state.flag;
    });
  }
}

export class Fields extends Store<{ keys: string[] }> {
  #fields: Map<string, Field> = new Map();

  public constructor(fields: Record<string, FieldSetup>) {
    super({ keys: Object.keys(fields) });
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

  @Fields.state("keys")
  public get fieldKeys(): string[] {
    return [...this.state.keys];
  }

  private changesToUncoveredProp(this: Fields): Observable<object> {
    return $observe(this).fieldKeys.pipe(
      switchMap((keys) => {
        if (keys.length === 0) {
          return NEVER;
        }
        return merge(
          ...keys.map((key) => {
            return $watch(this.getField(key)).uncovered;
          }),
        );
      }),
    );
  }

  private changesToFlagProp(this: Fields): Observable<object> {
    return $observe(this).fieldKeys.pipe(
      switchMap((keys) => {
        if (keys.length === 0) {
          return NEVER;
        }
        return merge(
          ...keys.map((key) => {
            return $watch(this.getField(key)).flag;
          }),
        );
      }),
    );
  }

  @invalidate(function () {
    return merge($watch(this).fieldKeys, this.changesToUncoveredProp());
  })
  public get coveredFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && !field.uncovered ? [field] : [];
    });
  }

  @dependencies()
  public get totalMines(): number {
    return this.fieldKeys.filter((key) => {
      const field = this.getField(key);
      return field && field.mine;
    }).length;
  }

  @invalidate(function () {
    return merge($watch(this).fieldKeys, this.changesToUncoveredProp());
  })
  public get uncoveredFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && field.uncovered ? [field] : [];
    });
  }

  @invalidate(function () {
    return merge($watch(this).fieldKeys, this.changesToFlagProp());
  })
  public get flaggedFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field && field.flag ? [field] : [];
    });
  }

  @dependencies("uncoveredFields")
  public get numberOfCoveredMines(): number {
    return this.uncoveredFields.filter((field) => field.mine).length;
  }

  @dependencies("flaggedFields", "totalMines")
  public get minesLeft(): number {
    return this.totalMines - this.flaggedFields.length;
  }

  @dependencies("fieldKeys")
  public get allFields(): Field[] {
    return this.fieldKeys.flatMap((key) => {
      const field = this.getField(key);
      return field ? [field] : [];
    });
  }

  @dependencies("allFields")
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

export const FieldsContext = createProperty<Fields>(new Fields({}));
