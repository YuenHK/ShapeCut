import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { EffectLevel } from './effect-level';

const PRESS_TARGET = 0.97;
const REST_TARGET = 1;
const RESPONSE_MS = 360;
const SETTLE_DISTANCE = 0.0001;

type SurfaceEventHandlers = {
  readonly onPointerDown?: React.PointerEventHandler<HTMLElement>;
  readonly onPointerUp?: React.PointerEventHandler<HTMLElement>;
  readonly onPointerCancel?: React.PointerEventHandler<HTMLElement>;
  readonly onLostPointerCapture?: React.PointerEventHandler<HTMLElement>;
  readonly onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  readonly onKeyUp?: React.KeyboardEventHandler<HTMLElement>;
  readonly onBlur?: React.FocusEventHandler<HTMLElement>;
};

type MotionSurfaceTag = 'button' | 'a' | 'div';

export type MotionSurfaceProps<T extends MotionSurfaceTag = 'button'> = {
  readonly as?: T;
  readonly level: EffectLevel;
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, 'as' | keyof SurfaceEventHandlers> & SurfaceEventHandlers;

function isPressKey(key: string) {
  return key === ' ' || key === 'Spacebar' || key === 'Enter';
}

function presentationScale(element: HTMLElement, fallback: number) {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--press-scale'));
  return Number.isFinite(value) ? value : fallback;
}

export function MotionSurface<T extends MotionSurfaceTag = 'button'>({
  as = 'button' as T,
  level,
  className,
  children,
  style,
  role,
  tabIndex,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: MotionSurfaceProps<T>) {
  const elementRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const valueRef = useRef(REST_TARGET);
  const velocityRef = useRef(0);
  const targetRef = useRef(REST_TARGET);
  const previousTimeRef = useRef<number | null>(null);
  const [pressed, setPressed] = useState(false);

  const cancelFrame = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  const writeScale = (value: number) => {
    valueRef.current = value;
    elementRef.current?.style.setProperty('--press-scale', String(value));
  };

  const runSpring = (time: number) => {
    const previousTime = previousTimeRef.current ?? time - 16.67;
    const elapsed = Math.min((time - previousTime) / 1000, 0.064);
    previousTimeRef.current = time;

    const omega = 4.6 / (RESPONSE_MS / 1000);
    const acceleration = omega * omega * (targetRef.current - valueRef.current) - 2 * omega * velocityRef.current;
    velocityRef.current += acceleration * elapsed;
    writeScale(valueRef.current + velocityRef.current * elapsed);

    if (Math.abs(targetRef.current - valueRef.current) <= SETTLE_DISTANCE && Math.abs(velocityRef.current) <= SETTLE_DISTANCE) {
      velocityRef.current = 0;
      writeScale(targetRef.current);
      frameRef.current = null;
      return;
    }

    frameRef.current = requestAnimationFrame(runSpring);
  };

  const retarget = (target: number) => {
    const element = elementRef.current;
    if (!element) return;

    targetRef.current = target;
    valueRef.current = presentationScale(element, valueRef.current);
    if (level === 'static') {
      cancelFrame();
      velocityRef.current = 0;
      writeScale(target);
      return;
    }

    if (frameRef.current === null) {
      previousTimeRef.current = null;
      frameRef.current = requestAnimationFrame(runSpring);
    }
  };

  const release = () => {
    setPressed(false);
    retarget(REST_TARGET);
  };

  useEffect(() => () => cancelFrame(), []);

  useEffect(() => {
    if (level === 'static') retarget(targetRef.current);
  }, [level]);

  const isNativeButton = as === 'button';
  const isDiv = as === 'div';
  const surfaceStyle = { ...style, '--press-scale': REST_TARGET } as CSSProperties;

  return createElement(as, {
    ...props,
    className,
    style: surfaceStyle,
    role: role ?? (isDiv ? 'button' : undefined),
    tabIndex: tabIndex ?? (isDiv ? 0 : undefined),
    ref: (element: HTMLElement | null) => {
      elementRef.current = element;
    },
    'data-motion': level,
    'data-pressed': String(pressed),
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setPressed(true);
      retarget(PRESS_TARGET);
      onPointerDown?.(event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      release();
      onPointerUp?.(event);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      release();
      onPointerCancel?.(event);
    },
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => {
      release();
      onLostPointerCapture?.(event);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (isPressKey(event.key)) {
        if (event.key !== 'Enter' && !isNativeButton) event.preventDefault();
        setPressed(true);
        retarget(PRESS_TARGET);
      }
      onKeyDown?.(event);
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLElement>) => {
      if (isPressKey(event.key)) release();
      onKeyUp?.(event);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      release();
      onBlur?.(event);
    },
  }, children);
}
