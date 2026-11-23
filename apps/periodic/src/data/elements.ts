/**
 * The 118 elements, one row each, and where each sits in the table.
 *
 * The figures are the usual reference values, rounded: the standard atomic
 * weight (the mass number of the longest-lived isotope, in brackets, for an
 * element with no stable one), Pauling electronegativity, the melting and
 * boiling points at one atmosphere in kelvin, the density near room
 * temperature in g/cm³ and the year the element was first identified, 0 for
 * one known since antiquity. Fluorine was identified in 1810, though not
 * isolated until 1886. Helium's year is 1895, when it was found on Earth:
 * the line seen in the Sun's spectrum in 1868 made it no element chemists
 * could handle, and Mendeleev's table of 1869 has no helium. A blank is a
 * value nobody has measured. An element that turns straight to gas at one
 * atmosphere, as carbon and arsenic do, has its sublimation point as both
 * its melting and its boiling point. From meitnerium on, too few atoms have
 * ever been made to say how the element behaves, so its category and
 * configuration are predicted.
 */

export type Category =
  | "alkali-metal"
  | "alkaline-earth"
  | "transition-metal"
  | "post-transition"
  | "metalloid"
  | "nonmetal"
  | "halogen"
  | "noble-gas"
  | "lanthanide"
  | "actinide";

export interface Element {
  number: number;
  symbol: string;
  name: string;
  /** The standard atomic weight, or the longest-lived isotope's mass number. */
  mass: number;
  /** Whether `mass` is a mass number, for an element with no stable isotope. */
  massIsotope: boolean;
  category: Category;
  /** The configuration after the noble gas core, as `[Ar] 3d5 4s1`. */
  configuration: string;
  electronegativity: number | null;
  /** Kelvin at one atmosphere; a sublimation point for both, where it sublimes. */
  melts: number | null;
  boils: number | null;
  /** g/cm³ near room temperature. */
  density: number | null;
  /** The year it was first identified; 0 for an element known since antiquity. */
  discovered: number;
  /** Whether the category and configuration are predicted rather than seen. */
  predicted: boolean;
  /** Electrons in each shell, innermost first, from the configuration. */
  shells: number[];
  /** The table's column, 1 to 18, and row: 1 to 7 for the periods, 9 and 10 for the f-block. */
  column: number;
  row: number;
  /** The element's period, 1 to 7. */
  period: number;
}

// number | symbol | name | mass | category | configuration | electronegativity
// | melts | boils | density | discovered
const ROWS = `
1|H|Hydrogen|1.008|nonmetal|1s1|2.20|13.99|20.27|0.00008988|1766
2|He|Helium|4.0026|noble-gas|1s2|||4.22|0.0001785|1895
3|Li|Lithium|6.94|alkali-metal|[He] 2s1|0.98|453.65|1603|0.534|1817
4|Be|Beryllium|9.0122|alkaline-earth|[He] 2s2|1.57|1560|2742|1.85|1798
5|B|Boron|10.81|metalloid|[He] 2s2 2p1|2.04|2349|4200|2.34|1808
6|C|Carbon|12.011|nonmetal|[He] 2s2 2p2|2.55|3915|3915|2.267|0
7|N|Nitrogen|14.007|nonmetal|[He] 2s2 2p3|3.04|63.15|77.36|0.0012506|1772
8|O|Oxygen|15.999|nonmetal|[He] 2s2 2p4|3.44|54.36|90.20|0.001429|1774
9|F|Fluorine|18.998|halogen|[He] 2s2 2p5|3.98|53.48|85.03|0.001696|1810
10|Ne|Neon|20.180|noble-gas|[He] 2s2 2p6||24.56|27.07|0.0009002|1898
11|Na|Sodium|22.990|alkali-metal|[Ne] 3s1|0.93|370.94|1156.09|0.968|1807
12|Mg|Magnesium|24.305|alkaline-earth|[Ne] 3s2|1.31|923|1363|1.738|1755
13|Al|Aluminium|26.982|post-transition|[Ne] 3s2 3p1|1.61|933.47|2743|2.70|1825
14|Si|Silicon|28.085|metalloid|[Ne] 3s2 3p2|1.90|1687|3538|2.329|1824
15|P|Phosphorus|30.974|nonmetal|[Ne] 3s2 3p3|2.19|317.3|553.7|1.823|1669
16|S|Sulfur|32.06|nonmetal|[Ne] 3s2 3p4|2.58|388.36|717.8|2.07|0
17|Cl|Chlorine|35.45|halogen|[Ne] 3s2 3p5|3.16|171.6|239.11|0.0032|1774
18|Ar|Argon|39.95|noble-gas|[Ne] 3s2 3p6||83.81|87.30|0.001784|1894
19|K|Potassium|39.098|alkali-metal|[Ar] 4s1|0.82|336.7|1032|0.862|1807
20|Ca|Calcium|40.078|alkaline-earth|[Ar] 4s2|1.00|1115|1757|1.55|1808
21|Sc|Scandium|44.956|transition-metal|[Ar] 3d1 4s2|1.36|1814|3109|2.985|1879
22|Ti|Titanium|47.867|transition-metal|[Ar] 3d2 4s2|1.54|1941|3560|4.506|1791
23|V|Vanadium|50.942|transition-metal|[Ar] 3d3 4s2|1.63|2183|3680|6.0|1801
24|Cr|Chromium|51.996|transition-metal|[Ar] 3d5 4s1|1.66|2180|2944|7.19|1797
25|Mn|Manganese|54.938|transition-metal|[Ar] 3d5 4s2|1.55|1519|2334|7.21|1774
26|Fe|Iron|55.845|transition-metal|[Ar] 3d6 4s2|1.83|1811|3134|7.874|0
27|Co|Cobalt|58.933|transition-metal|[Ar] 3d7 4s2|1.88|1768|3200|8.90|1735
28|Ni|Nickel|58.693|transition-metal|[Ar] 3d8 4s2|1.91|1728|3003|8.908|1751
29|Cu|Copper|63.546|transition-metal|[Ar] 3d10 4s1|1.90|1357.77|2835|8.96|0
30|Zn|Zinc|65.38|transition-metal|[Ar] 3d10 4s2|1.65|692.68|1180|7.14|1746
31|Ga|Gallium|69.723|post-transition|[Ar] 3d10 4s2 4p1|1.81|302.91|2673|5.91|1875
32|Ge|Germanium|72.630|metalloid|[Ar] 3d10 4s2 4p2|2.01|1211.40|3106|5.323|1886
33|As|Arsenic|74.922|metalloid|[Ar] 3d10 4s2 4p3|2.18|887|887|5.727|1250
34|Se|Selenium|78.971|nonmetal|[Ar] 3d10 4s2 4p4|2.55|494|958|4.81|1817
35|Br|Bromine|79.904|halogen|[Ar] 3d10 4s2 4p5|2.96|265.8|332.0|3.1028|1826
36|Kr|Krypton|83.798|noble-gas|[Ar] 3d10 4s2 4p6|3.00|115.78|119.93|0.003749|1898
37|Rb|Rubidium|85.468|alkali-metal|[Kr] 5s1|0.82|312.45|961|1.532|1861
38|Sr|Strontium|87.62|alkaline-earth|[Kr] 5s2|0.95|1050|1650|2.64|1790
39|Y|Yttrium|88.906|transition-metal|[Kr] 4d1 5s2|1.22|1799|3203|4.472|1794
40|Zr|Zirconium|91.224|transition-metal|[Kr] 4d2 5s2|1.33|2128|4650|6.52|1789
41|Nb|Niobium|92.906|transition-metal|[Kr] 4d4 5s1|1.6|2750|5017|8.57|1801
42|Mo|Molybdenum|95.95|transition-metal|[Kr] 4d5 5s1|2.16|2896|4912|10.28|1778
43|Tc|Technetium|98|transition-metal|[Kr] 4d5 5s2|1.9|2430|4538|11|1937
44|Ru|Ruthenium|101.07|transition-metal|[Kr] 4d7 5s1|2.2|2607|4423|12.45|1844
45|Rh|Rhodium|102.91|transition-metal|[Kr] 4d8 5s1|2.28|2237|3968|12.41|1804
46|Pd|Palladium|106.42|transition-metal|[Kr] 4d10|2.20|1828.05|3236|12.023|1802
47|Ag|Silver|107.87|transition-metal|[Kr] 4d10 5s1|1.93|1234.93|2435|10.49|0
48|Cd|Cadmium|112.41|transition-metal|[Kr] 4d10 5s2|1.69|594.22|1040|8.65|1817
49|In|Indium|114.82|post-transition|[Kr] 4d10 5s2 5p1|1.78|429.75|2345|7.31|1863
50|Sn|Tin|118.71|post-transition|[Kr] 4d10 5s2 5p2|1.96|505.08|2875|7.287|0
51|Sb|Antimony|121.76|metalloid|[Kr] 4d10 5s2 5p3|2.05|903.78|1908|6.697|0
52|Te|Tellurium|127.60|metalloid|[Kr] 4d10 5s2 5p4|2.1|722.66|1261|6.24|1782
53|I|Iodine|126.90|halogen|[Kr] 4d10 5s2 5p5|2.66|386.85|457.4|4.933|1811
54|Xe|Xenon|131.29|noble-gas|[Kr] 4d10 5s2 5p6|2.60|161.4|165.03|0.005894|1898
55|Cs|Caesium|132.91|alkali-metal|[Xe] 6s1|0.79|301.59|944|1.93|1860
56|Ba|Barium|137.33|alkaline-earth|[Xe] 6s2|0.89|1000|2118|3.51|1772
57|La|Lanthanum|138.91|lanthanide|[Xe] 5d1 6s2|1.10|1193|3737|6.162|1839
58|Ce|Cerium|140.12|lanthanide|[Xe] 4f1 5d1 6s2|1.12|1068|3716|6.770|1803
59|Pr|Praseodymium|140.91|lanthanide|[Xe] 4f3 6s2|1.13|1208|3403|6.77|1885
60|Nd|Neodymium|144.24|lanthanide|[Xe] 4f4 6s2|1.14|1297|3347|7.01|1885
61|Pm|Promethium|145|lanthanide|[Xe] 4f5 6s2|1.13|1315|3273|7.26|1945
62|Sm|Samarium|150.36|lanthanide|[Xe] 4f6 6s2|1.17|1345|2173|7.52|1879
63|Eu|Europium|151.96|lanthanide|[Xe] 4f7 6s2|1.2|1099|1802|5.264|1896
64|Gd|Gadolinium|157.25|lanthanide|[Xe] 4f7 5d1 6s2|1.20|1585|3546|7.90|1880
65|Tb|Terbium|158.93|lanthanide|[Xe] 4f9 6s2|1.2|1629|3396|8.23|1843
66|Dy|Dysprosium|162.50|lanthanide|[Xe] 4f10 6s2|1.22|1680|2840|8.540|1886
67|Ho|Holmium|164.93|lanthanide|[Xe] 4f11 6s2|1.23|1734|2873|8.79|1878
68|Er|Erbium|167.26|lanthanide|[Xe] 4f12 6s2|1.24|1802|3141|9.066|1843
69|Tm|Thulium|168.93|lanthanide|[Xe] 4f13 6s2|1.25|1818|2223|9.32|1879
70|Yb|Ytterbium|173.05|lanthanide|[Xe] 4f14 6s2|1.1|1097|1469|6.90|1878
71|Lu|Lutetium|174.97|lanthanide|[Xe] 4f14 5d1 6s2|1.27|1925|3675|9.841|1907
72|Hf|Hafnium|178.49|transition-metal|[Xe] 4f14 5d2 6s2|1.3|2506|4876|13.31|1923
73|Ta|Tantalum|180.95|transition-metal|[Xe] 4f14 5d3 6s2|1.5|3290|5731|16.69|1802
74|W|Tungsten|183.84|transition-metal|[Xe] 4f14 5d4 6s2|2.36|3695|6203|19.25|1783
75|Re|Rhenium|186.21|transition-metal|[Xe] 4f14 5d5 6s2|1.9|3459|5869|21.02|1925
76|Os|Osmium|190.23|transition-metal|[Xe] 4f14 5d6 6s2|2.2|3306|5285|22.59|1803
77|Ir|Iridium|192.22|transition-metal|[Xe] 4f14 5d7 6s2|2.20|2719|4403|22.56|1803
78|Pt|Platinum|195.08|transition-metal|[Xe] 4f14 5d9 6s1|2.28|2041.4|4098|21.45|1735
79|Au|Gold|196.97|transition-metal|[Xe] 4f14 5d10 6s1|2.54|1337.33|3243|19.3|0
80|Hg|Mercury|200.59|transition-metal|[Xe] 4f14 5d10 6s2|2.00|234.32|629.88|13.534|0
81|Tl|Thallium|204.38|post-transition|[Xe] 4f14 5d10 6s2 6p1|1.62|577|1746|11.85|1861
82|Pb|Lead|207.2|post-transition|[Xe] 4f14 5d10 6s2 6p2|2.33|600.61|2022|11.34|0
83|Bi|Bismuth|208.98|post-transition|[Xe] 4f14 5d10 6s2 6p3|2.02|544.7|1837|9.78|1753
84|Po|Polonium|209|post-transition|[Xe] 4f14 5d10 6s2 6p4|2.0|527|1235|9.196|1898
85|At|Astatine|210|halogen|[Xe] 4f14 5d10 6s2 6p5|2.2|575|610||1940
86|Rn|Radon|222|noble-gas|[Xe] 4f14 5d10 6s2 6p6|2.2|202|211.5|0.00973|1899
87|Fr|Francium|223|alkali-metal|[Rn] 7s1|0.7|300|950||1939
88|Ra|Radium|226|alkaline-earth|[Rn] 7s2|0.9|973|2010|5.5|1898
89|Ac|Actinium|227|actinide|[Rn] 6d1 7s2|1.1|1323|3471|10.07|1899
90|Th|Thorium|232.04|actinide|[Rn] 6d2 7s2|1.3|2023|5061|11.72|1829
91|Pa|Protactinium|231.04|actinide|[Rn] 5f2 6d1 7s2|1.5|1841|4300|15.37|1913
92|U|Uranium|238.03|actinide|[Rn] 5f3 6d1 7s2|1.38|1405.3|4404|19.1|1789
93|Np|Neptunium|237|actinide|[Rn] 5f4 6d1 7s2|1.36|912|4447|20.45|1940
94|Pu|Plutonium|244|actinide|[Rn] 5f6 7s2|1.28|912.5|3505|19.82|1940
95|Am|Americium|243|actinide|[Rn] 5f7 7s2|1.13|1449|2880|12|1944
96|Cm|Curium|247|actinide|[Rn] 5f7 6d1 7s2|1.28|1613|3383|13.51|1944
97|Bk|Berkelium|247|actinide|[Rn] 5f9 7s2|1.3|1259|2900|14.78|1949
98|Cf|Californium|251|actinide|[Rn] 5f10 7s2|1.3|1173|1743|15.1|1950
99|Es|Einsteinium|252|actinide|[Rn] 5f11 7s2|1.3|1133||8.84|1952
100|Fm|Fermium|257|actinide|[Rn] 5f12 7s2|1.3|1800|||1952
101|Md|Mendelevium|258|actinide|[Rn] 5f13 7s2|1.3|1100|||1955
102|No|Nobelium|259|actinide|[Rn] 5f14 7s2|1.3|1100|||1966
103|Lr|Lawrencium|266|actinide|[Rn] 5f14 7s2 7p1|1.3|1900|||1961
104|Rf|Rutherfordium|267|transition-metal|[Rn] 5f14 6d2 7s2|||||1964
105|Db|Dubnium|268|transition-metal|[Rn] 5f14 6d3 7s2|||||1967
106|Sg|Seaborgium|269|transition-metal|[Rn] 5f14 6d4 7s2|||||1974
107|Bh|Bohrium|270|transition-metal|[Rn] 5f14 6d5 7s2|||||1981
108|Hs|Hassium|269|transition-metal|[Rn] 5f14 6d6 7s2|||||1984
109|Mt|Meitnerium|278|transition-metal|[Rn] 5f14 6d7 7s2|||||1982
110|Ds|Darmstadtium|281|transition-metal|[Rn] 5f14 6d8 7s2|||||1994
111|Rg|Roentgenium|282|transition-metal|[Rn] 5f14 6d9 7s2|||||1994
112|Cn|Copernicium|285|transition-metal|[Rn] 5f14 6d10 7s2|||||1996
113|Nh|Nihonium|286|post-transition|[Rn] 5f14 6d10 7s2 7p1|||||2004
114|Fl|Flerovium|289|post-transition|[Rn] 5f14 6d10 7s2 7p2|||||1998
115|Mc|Moscovium|290|post-transition|[Rn] 5f14 6d10 7s2 7p3|||||2003
116|Lv|Livermorium|293|post-transition|[Rn] 5f14 6d10 7s2 7p4|||||2000
117|Ts|Tennessine|294|halogen|[Rn] 5f14 6d10 7s2 7p5|||||2010
118|Og|Oganesson|294|noble-gas|[Rn] 5f14 6d10 7s2 7p6|||||2002
`;

/** The first element whose category and configuration are only predicted. */
const FIRST_PREDICTED = 109;

/** The atomic number each period ends on. */
const PERIOD_ENDS = [2, 10, 18, 36, 54, 86, 118];

/** The noble gas cores a configuration may start from, by symbol. */
const CORES: Record<string, string> = {
  He: "1s2",
  Ne: "1s2 2s2 2p6",
  Ar: "1s2 2s2 2p6 3s2 3p6",
  Kr: "1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6",
  Xe: "1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6 4d10 5s2 5p6",
  Rn: "1s2 2s2 2p6 3s2 3p6 3d10 4s2 4p6 4d10 5s2 5p6 4f14 5d10 6s2 6p6",
};

/**
 * Electrons in each shell, innermost first, for a configuration written as
 * the table writes it: an optional noble gas core in brackets, then
 * subshells such as `3d5`.
 */
export function shellsOf(configuration: string): number[] {
  const expanded = configuration.replace(/\[(\w+)\]/, (_, core: string) => {
    const subshells = CORES[core];
    if (!subshells) {
      throw new Error(`Unknown core [${core}]`);
    }
    return subshells;
  });
  const shells: number[] = [];
  for (const subshell of expanded.trim().split(/\s+/)) {
    const match = /^(\d)([spdf])(\d+)$/.exec(subshell);
    if (!match) {
      throw new Error(`Cannot read subshell ${subshell}`);
    }
    const shell = Number(match[1]) - 1;
    while (shells.length <= shell) {
      shells.push(0);
    }
    shells[shell] += Number(match[3]);
  }
  return shells;
}

/**
 * Where element `number` sits: its column and row in the table, with
 * lanthanum to lutetium and actinium to lawrencium in the two rows under
 * it, and its period.
 */
export function placeOf(number: number): { column: number; row: number; period: number } {
  const period = PERIOD_ENDS.findIndex((end) => number <= end) + 1;
  if (period === 0) {
    throw new Error(`No element ${number}`);
  }
  const offset = number - (period === 1 ? 0 : PERIOD_ENDS[period - 2]) - 1;
  if (period === 1) {
    return { column: offset === 0 ? 1 : 18, row: 1, period };
  }
  if (period <= 3) {
    return { column: offset < 2 ? offset + 1 : offset + 11, row: period, period };
  }
  if (period <= 5) {
    return { column: offset + 1, row: period, period };
  }
  if (offset < 2) {
    return { column: offset + 1, row: period, period };
  }
  if (offset < 17) {
    // The f-block: one of the two rows under the table.
    return { column: offset + 1, row: period + 3, period };
  }
  return { column: offset - 13, row: period, period };
}

const optional = (field: string) => (field === "" ? null : Number(field));

export const ELEMENTS: readonly Element[] = ROWS.trim()
  .split("\n")
  .map((line) => {
    const [number, symbol, name, mass, category, configuration, en, melts, boils, density, year] =
      line.split("|");
    const z = Number(number);
    return {
      number: z,
      symbol,
      name,
      mass: Number(mass),
      massIsotope: !mass.includes("."),
      category: category as Category,
      configuration,
      electronegativity: optional(en),
      melts: optional(melts),
      boils: optional(boils),
      density: optional(density),
      discovered: Number(year),
      predicted: z >= FIRST_PREDICTED,
      shells: shellsOf(configuration),
      ...placeOf(z),
    };
  });

export const elementByNumber = (number: number): Element | undefined => ELEMENTS[number - 1];

/**
 * The four elements Mendeleev predicted before they were found: the year
 * his table first left room for each, and the name he gave it. His table of
 * 1869 has unnamed gaps for scandium, gallium and germanium; his paper of
 * 1871 named those three and added a fourth, eka-manganese, which became
 * technetium.
 */
export interface Prediction {
  gapSince: number;
  name: string;
}

/** The year Mendeleev named the elements he predicted. */
export const MENDELEEV_NAMED = 1871;

export const MENDELEEV_PREDICTIONS: Readonly<Record<number, Prediction>> = {
  21: { gapSince: 1869, name: "eka-boron" },
  31: { gapSince: 1869, name: "eka-aluminium" },
  32: { gapSince: 1869, name: "eka-silicon" },
  43: { gapSince: MENDELEEV_NAMED, name: "eka-manganese" },
};

/** The year Mendeleev published his table. */
export const MENDELEEV_YEAR = 1869;

/** What a substance is at `kelvin`, at one atmosphere, or null where nobody knows. */
export type Phase = "solid" | "liquid" | "gas";

/** Room temperature, in kelvin: 25 °C. */
export const ROOM_KELVIN = 298;

export function phaseAt(element: Element, kelvin: number): Phase | null {
  const { melts, boils } = element;
  if (boils !== null && kelvin >= boils) {
    return "gas";
  }
  if (melts !== null && kelvin >= melts) {
    // Melted, and not known to boil yet: a liquid as far as anyone has seen.
    return "liquid";
  }
  if (melts !== null) {
    return "solid";
  }
  // Helium, which no cold freezes at one atmosphere, is a liquid until it
  // boils. An element with neither figure is a blank.
  return boils !== null ? "liquid" : null;
}

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  "alkali-metal": "Alkali metal",
  "alkaline-earth": "Alkaline earth metal",
  "transition-metal": "Transition metal",
  "post-transition": "Post-transition metal",
  metalloid: "Metalloid",
  nonmetal: "Nonmetal",
  halogen: "Halogen",
  "noble-gas": "Noble gas",
  lanthanide: "Lanthanide",
  actinide: "Actinide",
};
