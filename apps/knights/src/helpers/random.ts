const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(n = 16): string {
  let id = "";
  while (id.length < n) {
    id += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return id;
}

export function randomFraction(): number {
  return Math.random();
}
