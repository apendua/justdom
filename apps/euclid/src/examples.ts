export interface Example {
  name: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    name: "Equilateral triangle",
    code: [
      "// Elements, Book I, Proposition 1:",
      "// an equilateral triangle on a given segment.",
      "A=point(0, 0);",
      "B=point(4, 0);",
      "c1=circle(A, B-A);",
      "c2=circle(B, A-B);",
      "C=pick P in c1.c2: P.y > 0;",
      "draw {A, B, C};",
      "",
    ].join("\n"),
  },
  {
    name: "Perpendicular bisector",
    code: [
      "// The perpendicular bisector of AB,",
      "// constructed with two circles.",
      "A=point(-2, 0);",
      "B=point(2, 0);",
      "c1=circle(A, B-A);",
      "c2=circle(B, A-B);",
      "P=pick Q in c1.c2: Q.y > 0;",
      "R=pick Q in c1.c2: Q.y < 0;",
      "l=line(P, R);",
      "draw l;",
      "",
    ].join("\n"),
  },
  {
    name: "Pentagon (approximate)",
    code: [
      "// The classic approximate pentagon construction:",
      "// exactly equilateral, very nearly regular.",
      "A=point(0,0);",
      "B=point(5,0);",
      "draw line(A,B);",
      "l=line(A+0.5*(B-A),line(A,B).rot(90).inf);",
      "c1=circle(A,B-A);",
      "c2=circle(B,A-B);",
      "C=pick P in c1.c2: P.y > 0;",
      "c3=circle(C,A-C);",
      "D=pick P in c3.l: P in c2;",
      "E=pick P in c3.c1: P != B;",
      "F=pick P in c3.c2: P != A;",
      "k1=line(E,D);",
      "k2=line(F,D);",
      "G=pick P in c1.k2: not (P in c2);",
      "H=pick P in c2.k1: not (P in c1);",
      "c4=circle(H,H-B);",
      "I=pick P in c4.l: not (P in c1);",
      "draw {A,B,H,I,G};",
      "",
    ].join("\n"),
  },
  {
    name: "Blank canvas",
    code: [
      "// Pick a tool on the left and start constructing,",
      "// or type euclid code right here.",
      "",
    ].join("\n"),
  },
];
