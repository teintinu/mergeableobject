
import * as React from "react"
import "@hoda5/extensions"
import { h5debug } from "@hoda5/h5debug"

export type PathPart<T> = keyof T
  | { [name: string]: (value: any) => (false | string | GUID | Array<string | GUID>) }
  | (() => (false | string | GUID | Array<string | GUID>))
export type Path<T> = Array<PathPart<T>>
export interface QueryParams { [name: string]: any }

export type ReadOnlyObject<T> =
  T extends object ? {
    readonly [name in keyof T]: ReadOnlyObject<T[name]>
  } : T

export type Subscription<
  T extends object,
  C extends object,
  M extends {
    [name: string]: (this: Subscription<T, C, M, P>, ...args: any[]) => any,
  },
  P extends QueryParams,
  > =
  {
    readonly fullPath: string;
    readonly pending: boolean;
    data: T & ReadOnlyObject<C>,
    original: ReadOnlyObject<T & C>,
    theirs: ReadOnlyObject<T & C>,
    changes: {
      [name: string]: MergeableValue,
    },
  } & M & {
    reset(): void;
    commit(): void;
    get(relativePath: string): MergeableValue;
    getData(relativePath: string): any;
    setData(relativePath: string, value: any): void;
    unsubscribe(): void;
  }

export interface MergeableValue {
  data: any
  readonly original: any
  readonly theirs: any
  readonly conflict: boolean
  reset(): void
  resolve(value: any): void
}

export interface Repository {
  name: string
  onSubscribe(fullPath: string, onPull: (delta: object) => void): {
    stop(): void,
  }
  onPush(delta: object): void
}

export function testRepository<T>(opts: { name: string, db: T }) {
  const handles: Array<{ fullPath: string, onPull: (delta: object) => void }> = []
  let workData = opts.db.cloneObj()
  const self: Repository & { db: T, resetDB(): Promise<void> } = {
    name: opts.name,
    db: opts.db,
    async resetDB() {
      workData = opts.db.cloneObj()
    },
    onSubscribe(fullPath, onPull) {
      const handle = { fullPath, onPull }
      handles.push(handle)
      notify()
      return {
        stop() {
          const i = handles.indexOf(handle)
          if (i >= 0) handles.splice(i, 1)
        },
      }
    },
    onPush(delta) {
      Object.keys(delta).forEach((fullPath) => {
        workData.setPropByPath(fullPath, delta[fullPath])
      })
      notify()
    },
  }
  return self
  function notify() {
    handles.forEach((h) => {
      asap(() => {
        const v = workData.getPropByPath(h.fullPath)
        h.onPull({ [h.fullPath]: v })
      })
    })
  }
}

export function distribuitedDatabase<DOCS extends {
  [name: string]: MergeableObject<any, any, any, any, any>,
}>(docs: DOCS): {
    docs: {
      [name in keyof DOCS]: {
        doc: DOCS[name],
        search(): void,
        validate(): void,
      }
    },
  } {
  return null as any
}

export function mergeableObject<T extends object>() {
  return {
    define<
      M extends {
        [name: string]: (this: Subscription<T, {}, M, P>, ...args: any[]) => any,
      },
      P extends QueryParams,
      >(opts: {
        basePath: Path<P>,
        methods: M,
        params: P,
        repositories: Repository[],
        validate?(data: T): void,
      }) {
      return defineMergeableObject<T, {}, {}, M, P>(opts)
    },
    // withComputation<C extends object>( fn: (data: T)
  }
}

export interface MergeableObject<
  T extends object,
  C1 extends object,
  C2 extends object,
  M extends {
    [name: string]: (this: Subscription<T, C1 & C2, M, P>, ...args: any[]) => any,
  },
  P extends QueryParams,
  > {
  subscribe(queryParams: P, onChange: (subscription: Subscription<T, C1 & C2, M, P>) => void):
    Subscription<T, C1 & C2, M, P>,
}

function defineMergeableObject<
  T extends object,
  C1 extends object,
  C2 extends object,
  M extends {
    [name: string]: (this: Subscription<T, C1 & C2, M, P>, ...args: any[]) => any,
  },
  P extends QueryParams,
  >(opts: {
    basePath: Path<P>,
    methods: M,
    params: P,
    computation1?: {
      [name in keyof C1]: () => C1[name]
    },
    computation2?: {
      [name in keyof C2]: () => C2[name]
    }
    repositories: Repository[],
    validate?(data: T): void,
  }): MergeableObject<T, C1, C2, M, P> {

  const { basePath, repositories } = opts
  const subscriptions: { [relativePath: string]: Subscription<any, any, any, any> } = {}

  return {
    subscribe(queryParams: P, onChange) {
      const fullPath = resolveQueryPath(basePath, queryParams)
      let sub = subscriptions[fullPath]
      if (!sub) {
        sub = subscriptions[fullPath] = createSubscribe(fullPath)
      }
      sub.addChangeListenner(onChange)
      return sub
    },
  }
  function createSubscribe(fullPath: string) {
    const self: Subscription<T, C1 & C2, M, P> = {} as any
    const changeListenners: Array<(subscription: Subscription<T, C1 & C2, M, P>) => void> = []
    let subinfo: Array<{ stop(): void }> | undefined
    let state: 1 | 2 | 3 | 4 = 1 // 1=not initialized, 2=subscribing, 3=clean, 4=dirty
    let data = {}
    let original = {}
    let theirs = {}
    const props: PropertyDescriptorMap = {
      fullPath: {
        value: fullPath,
      },
      pending: {
        get() {
          if (state <= 2) subscribe()
          return state <= 2
        },
      },
      dirty: {
        get() {
          if (state <= 2) subscribe()
          return state === 2 && getChanges()
        },
      },
      data: {
        get() {
          if (state === 1) subscribe()
          return data
        },
      },
      original: {
        get() {
          if (state === 1) subscribe()
          return original
        },
      },
      theirs: {
        get() {
          if (state === 1) subscribe()
          return theirs
        },
      },
      changes: {
        get() {
          if (state === 1) subscribe()
          return getChanges()
        },
      },
      reset: {
        value() {
          if (state === 3) reset()
        },
      },
      commit: {
        value() {
          if (state === 3) commitAndPush()
        },
      },
      get: {
        value(relativePath: string) {
          const r: MergeableValue = {
            get data() {
              return data.getPropByPath(relativePath)
            },
            set data(value: any) {
              data.setPropByPath(relativePath, value)
            },
            get original() {
              return original.getPropByPath(relativePath)
            },
            get theirs() {
              return theirs.getPropByPath(relativePath)
            },
            get conflict() {
              return false // TODO
            },
            reset() {
              // TODO
            },
            resolve(value) {
              // TODO
            },
          }
          return r
        },
      },
      getValue: {
        value(relativePath: string) {
          return data.getPropByPath(relativePath)
        },
      },
      setValue: {
        value(relativePath: string, value: any) {
          data.setPropByPath(relativePath, value)
        },
      },
      addChangeListenner: {
        value(onChange: (subscription: Subscription<T, C1 & C2, M, P>) => void) {
          changeListenners.push(onChange)
        },
      },
      unsubscribe: {
        value: unsubscribe,
      },
    }
    Object.defineProperties(self, props)
    return self
    function getChanges(): false | { [relativePath: string]: any } {
      // TODO
      return null as any
    }
    function dispathChanges() {
      changeListenners.forEach((ev) => asap(() => ev(self)))
    }

    function subscribe() {
      if (state !== 1) return
      data = {}
      original = {}
      theirs = {}
      state = 2
      subinfo = repositories.map((r) => r.onSubscribe(fullPath, (delta) => {
        Object.keys(delta).forEach((dfp) => {
          const d = delta[dfp]
          theirs.setPropByPath(dfp, d)
        })
        if (state <= 3) {
          original = theirs.cloneObj()
          data = original.cloneObj()
          state = 3
        }
        dispathChanges()
      }))
    }
    function unsubscribe() {
      if (state === 1) return
      state = 1
      const si = subinfo
      subinfo = undefined
      if (si) si.forEach((s) => s.stop())
    }

    function onPull(d: T) {
      theirs = d.cloneObj()
      if (state === 2) {
        original = d.cloneObj()
        data = d.cloneObj()
        state = 3
      }
    }

    function reset() {
      original = theirs.cloneObj()
      data = original.cloneObj()
      state = 3
      dispathChanges()
    }

    function commitAndPush() {
      if (state === 3) {
        subinfo = repositories.map((r) => r.onPush.call(getChanges()))
        state = 2
      }
    }
  }
}

// public rx<P>(Component: React.ComponentType<P>): React.ComponentClass<P> {
//   const dep = this;
//   // tslint:disable-next-line:max-classes-per-file
//   return class extends React.Component<P, {}, {}> {
//     public comp?: any;
//     public componentWillMount() {
//       this.comp = autorun((dep as any).h5debugname + ".rx", () => {
//         dep.depend();
//         nonreactive(() => this.setState({}));
//       });
//     }
//     public componentWillUnmount() {
//       if (this.comp) {
//         this.comp.stop();
//       }
//     }
//     public render() {
//       return React.createElement(ErrorBoundary, null,
//         React.createElement(Component, this.props));
//     }
//   };
// }
// }

// // tslint:disable-next-line:max-classes-per-file
// class ErrorBoundary extends React.Component<{}, { hasError: false | string }> {
// constructor(props) {
//   super(props);
//   this.state = { hasError: false };
// }

// public componentDidCatch(error, info) {
//   this.setState({
//     hasError: JSON.stringify({
//       info,
//       error: error.stack ? error.stack.toString() : error.message,
//     }, null, 2).replace(/\\n/g, "\n"),
//   });
// }

// public render() {
//   if (this.state.hasError) return React.createElement("pre", null, this.state.hasError);
//   return this.props.children;
// }
// }

export function resolveQueryPath<P extends QueryParams>(
  path: Path<P>, paramValues: P): string {
  const arr: Array<string | GUID> = []
  path.forEach((p) => {
    const t = typeof p
    if (t === "string") p = paramValues[p as any]
    else if (t === "object") {
      const n = Object.keys(p)[0]
      const fn: any = p[n]
      p = fn(paramValues[n])
    } else if (t === "function") {
      p = (p as any)()
    }
    if (Array.isArray(p)) arr.push(...p)
    else arr.push(p as any)
  })
  // if (h5debug.h5doc) h5debug.h5doc(qry.name, qry.paramValues, "resolveQueryPath", r)
  return arr.join("/")
}
