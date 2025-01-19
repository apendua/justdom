import * as THREE from "three";
import { Observable } from "rxjs";

/**
 * @import { XREventMap } from './core.js';
 */

/**
 * @returns {Observable<THREE.Object3D<XREventMap>>}
 */
export function object() {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.Object3D());
  });
}

/**
 * @param {ConstructorParameters<typeof THREE.Mesh>} args
 * @returns {Observable<THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[], XREventMap>>}
 */
export function mesh(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.Mesh(...args));
  });
}

/**
 * @returns {Observable<THREE.Group<XREventMap>>}
 */
export function group() {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.Group());
  });
}

/**
 * @returns {Observable<THREE.Scene>}
 */
export function scene() {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.Scene());
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.PerspectiveCamera>} args
 * @returns {Observable<THREE.PerspectiveCamera>}
 */
export function perspectiveCamera(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.PerspectiveCamera(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.OrthographicCamera>} args
 * @returns {Observable<THREE.OrthographicCamera>}
 */
export function orthographicCamera(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.OrthographicCamera(...args));
  });
}

/**
 * @param {ConstructorParameters<typeof THREE.DirectionalLight>} args
 * @returns {Observable<THREE.DirectionalLight>}
 */
export function directionalLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.DirectionalLight(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.AmbientLight>} args
 * @returns {Observable<THREE.AmbientLight>}
 */
export function ambientLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.AmbientLight(...args));
  });
}

/**
 * @param {ConstructorParameters<typeof THREE.PointLight>} args
 * @returns {Observable<THREE.PointLight>}
 */
export function pointLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.PointLight(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.SpotLight>} args
 * @returns {Observable<THREE.SpotLight>}
 */
export function spotLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.SpotLight(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.HemisphereLight>} args
 * @returns {Observable<THREE.HemisphereLight>}
 */
export function hemisphereLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.HemisphereLight(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.RectAreaLight>} args
 * @returns {Observable<THREE.RectAreaLight>}
 */
export function rectAreaLight(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.RectAreaLight(...args));
  });
}

/**
 * @param  {ConstructorParameters<typeof THREE.LightProbe>} args
 * @returns {Observable<THREE.LightProbe>}
 */
export function lightProbe(...args) {
  return new Observable((subscriber) => {
    subscriber.next(new THREE.LightProbe(...args));
  });
}
