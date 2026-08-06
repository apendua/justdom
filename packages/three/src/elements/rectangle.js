import * as THREE from "three";

/**
 * @typedef {object} RectangleParams
 * @property {number} left
 * @property {number} leftTop
 * @property {number} leftBottom
 * @property {number} right
 * @property {number} rightTop
 * @property {number} rightBottom
 * @property {number} top
 * @property {number} topLeft
 * @property {number} topRight
 * @property {number} bottom
 * @property {number} bottomLeft
 * @property {number} bottomRight
 */

/**
 * @param {THREE.Path} path
 * @param {RectangleParams} params
 * @returns {void}
 */
export function drawRoundedRectanglePath(path, params) {
  path.moveTo(params.left, params.leftTop);
  if (params.leftBottom < params.bottom && params.left < params.bottomLeft) {
    path.lineTo(params.left, params.leftBottom);
    path.quadraticCurveTo(params.left, params.bottom, params.bottomLeft, params.bottom);
  } else {
    path.lineTo(params.left, params.bottom);
  }
  if (params.bottomRight < params.right && params.rightBottom < params.bottom) {
    path.lineTo(params.bottomRight, params.bottom);
    path.quadraticCurveTo(params.right, params.bottom, params.right, params.rightBottom);
  } else {
    path.lineTo(params.right, params.bottom);
  }
  if (params.top < params.rightTop && params.topRight < params.right) {
    path.lineTo(params.right, params.rightTop);
    path.quadraticCurveTo(params.right, params.top, params.topRight, params.top);
  } else {
    path.lineTo(params.right, params.top);
  }
  if (params.left < params.topLeft && params.top < params.leftTop) {
    path.lineTo(params.topLeft, params.top);
    path.quadraticCurveTo(params.left, params.top, params.left, params.leftTop);
  } else {
    path.lineTo(params.left, params.top);
  }
}

/**
 * @param {THREE.Path} path
 * @param {RectangleParams} params
 * @returns {void}
 */
export function drawRoundedRectanglePathCW(path, params) {
  path.moveTo(params.topLeft, params.top);
  if (params.topRight < params.right && params.rightTop > params.top) {
    path.lineTo(params.topRight, params.top);
    path.quadraticCurveTo(params.right, params.top, params.right, params.rightTop);
  } else {
    path.lineTo(params.right, params.top);
  }
  if (params.rightBottom < params.bottom && params.bottomRight < params.right) {
    path.lineTo(params.right, params.rightBottom);
    path.quadraticCurveTo(params.right, params.bottom, params.bottomRight, params.bottom);
  } else {
    path.lineTo(params.right, params.bottom);
  }
  if (params.bottomLeft > params.left && params.leftBottom < params.bottom) {
    path.lineTo(params.bottomLeft, params.bottom);
    path.quadraticCurveTo(params.left, params.bottom, params.left, params.leftBottom);
  } else {
    path.lineTo(params.left, params.bottom);
  }
  if (params.leftTop > params.top && params.topLeft > params.left) {
    path.lineTo(params.left, params.leftTop);
    path.quadraticCurveTo(params.left, params.top, params.topLeft, params.top);
  } else {
    path.lineTo(params.left, params.top);
  }
}

/**
 * @param {RectangleParams} params
 * @param {object} amount
 * @param {number} amount.left
 * @param {number} amount.right
 * @param {number} amount.top
 * @param {number} amount.bottom
 * @returns {RectangleParams}
 */
export function shrinkRectangle(params, amount) {
  const left = params.left + amount.left;
  const right = params.right - amount.right;
  const top = params.top + amount.top;
  const bottom = params.bottom - amount.bottom;

  const topLeftDegenerated = params.leftTop <= top || params.topLeft <= left;
  const topRightDegenerated = params.rightTop <= top || params.topRight >= right;
  const bottomLeftDegenerated = params.leftBottom >= bottom || params.bottomLeft <= left;
  const bottomRightDegenerated = params.rightBottom > bottom || params.bottomRight >= right;

  return {
    left,
    leftTop: topLeftDegenerated ? top : params.leftTop,
    leftBottom: bottomLeftDegenerated ? bottom : params.leftBottom,
    right,
    rightTop: topRightDegenerated ? top : params.rightTop,
    rightBottom: bottomRightDegenerated ? bottom : params.rightBottom,
    top,
    topLeft: topLeftDegenerated ? left : params.topLeft,
    topRight: topRightDegenerated ? right : params.topRight,
    bottom,
    bottomLeft: bottomLeftDegenerated ? left : params.bottomLeft,
    bottomRight: bottomRightDegenerated ? right : params.bottomRight,
  };
}

/**
 * @param {RectangleParams} params
 * @param {object} [border]
 * @param {number} border.left
 * @param {number} border.right
 * @param {number} border.top
 * @param {number} border.bottom
 * @returns {THREE.BufferGeometry}
 */
export function makeRectangleGeometry(params, border) {
  // A ring of no width has nothing in it. Falling through would push a hole
  // exactly on top of the outline it was cut from, and the triangulator does
  // not answer "nothing" to that — on a rounded element it fills a good part
  // of the shape with slivers, which then draw over the element in whatever
  // colour the border would have been. An element with no border at all is
  // the common case, so this is most of them.
  if (border && border.left <= 0 && border.right <= 0 && border.top <= 0 && border.bottom <= 0) {
    const empty = new THREE.BufferGeometry();
    empty.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    return empty;
  }
  const shape = new THREE.Shape();
  drawRoundedRectanglePath(shape, params);
  if (border) {
    const path = new THREE.Path();
    drawRoundedRectanglePathCW(path, shrinkRectangle(params, border));
    shape.holes.push(path);
  }
  const geometry = new THREE.ShapeGeometry(shape);
  return geometry;
}
