/// <reference path="../typings/bluebird/bluebird.d.ts"/>

namespace yelm.rt {
    export module U {
        export function assert(cond: boolean, msg = "Assertion failed") {
            if (!cond) {
                debugger
                throw new Error(msg)
            }
        }        
        
        export function repeatMap<T>(n : number, fn : (index:number) => T) : T[] {
            n = n || 0;
            let r : T[] = [];
            for(let i = 0;i<n;++i) r.push(fn(i));
            return r;
        }
        
        export function userError(msg: string): Error {
            let e = new Error(msg);
            (<any>e).isUserError = true;
            throw e
        }
        
        export function now() : number {
            return Date.now();
        }
        
        export function nextTick(f: () => void) {
            (<any>Promise)._async._schedule(f)
        }
    }
    
    export interface Map<T> {
        [index: string]: T;
    }
    
    export type LabelFn = (n: number) => CodePtr;
    export type ResumeFn = (v?: any) => void;

    export interface Target {
        name: string;
        initCurrentRuntime: () => void;
    }

    export function getTargets(): Target[] {
        return [micro_bit.target, minecraft.target]
    }

    export interface CodePtr {
        fn: LabelFn;
        pc: number;
    }

    interface LR {
        caller: LR;
        retPC: number;
        currFn: LabelFn;
        baseSP: number;
        finalCallback?: ResumeFn;
    }

    export var runtime: Runtime;
    export function getResume() { return runtime.getResume() }

    export class BaseBoard {
        public updateView() { }
        public receiveMessage(msg: SimulatorMessage) {}
    }

    export class EventQueue<T> {
        max: number = 5;
        events: T[] = [];
        handler: RefAction;
        
        constructor(public runtime: Runtime) {}
        
        public push(e: T) {
            if (!this.handler || this.events.length > this.max) return;
            
            this.events.push(e)
            
            // if this is the first event pushed - start processing
            if (this.events.length == 1)
                this.poke();
        }
        
        private poke() {
            let top = this.events.shift()
            this.runtime.runFiberAsync(this.handler, top)
                .done(() => {
                    // we're done processing the current event, if there is still something left to do, do it
                    if (this.events.length > 0)
                        this.poke();
                })
        }
    }

    export class Runtime {
        private baseStack = 1000000;
        private freeStacks: number[] = [];
        public board: BaseBoard;
        numGlobals = 1000;
        mem: any;
        errorHandler: (e: any) => void;
        stateChanged: () => void;
        dead = false;
        running = false;
        startTime = 0;
        target: Target;
        enums: Map<number>;

        getResume: () => ResumeFn;
        run: (cb: ResumeFn) => void;
        setupTop: (cb: ResumeFn) => void;

        runningTime(): number {
            return U.now() - this.startTime;
        }

        runFiberAsync(a: RefAction, arg0?:any, arg1?:any) {
            incr(a)
            return new Promise<any>((resolve, reject) =>
                U.nextTick(() => {
                    this.setupTop(resolve)
                    action.run2(a, arg0, arg1)
                    decr(a) // if it's still running, action.run() has taken care of incrementing the counter
                }))
        }
        
        // communication
        static postMessage(data: any) {
            // TODO: origins
            if (typeof window !== 'undefined' && window.parent) {
                window.parent.postMessage(data, "*");
            }
        }

        // 2k block
        malloc() {
            if (this.freeStacks.length > 0)
                return this.freeStacks.pop();
            this.baseStack += 2000;
            return this.baseStack;
        }

        free(p: number) {
            this.freeStacks.push(p)
        }

        kill() {
            this.dead = true
            // TODO fix this
            this.setRunning(false);
        }

        updateDisplay() {
            this.board.updateView()
        }

        private numDisplayUpdates = 0;
        queueDisplayUpdate() {
            this.numDisplayUpdates++
        }

        maybeUpdateDisplay() {
            if (this.numDisplayUpdates) {
                this.numDisplayUpdates = 0
                this.updateDisplay()
            }
        }

        setRunning(r: boolean) {
            if (this.running != r) {
                this.running = r;
                if (this.running) {
                    this.startTime = U.now();
                    Runtime.postMessage({ kind: 'status', state: 'running' });
                } else {
                    Runtime.postMessage({ kind: 'status', state: 'killed' });                    
                }
                if (this.stateChanged) this.stateChanged();
            }
        }

        constructor(code: string, targetName: string, enums: Map<number>) {            
            this.enums = enums;
            // These variables are used by the generated code as well
            // ---
            var sp: number, lr: LR;
            var rr0: any, rr1: any, rr2: any, rr3: any;
            var r4: any, r5: any, r6: any, r7: any;
            var mem: any = {}
            var entryPoint: LabelFn;
            // ---

            var currResume: ResumeFn;
            this.mem = mem
            var _this = this

            function oops(msg: string) {
                throw new Error("sim error: " + msg)
            }

            function push(v: any) {
                sp -= 4;
                if (sp % 1000 == 0)
                    oops("stack overflow")
                mem[sp] = v;
                //console.log(`PUSH ${sp} ${v}`)
            }

            function pop() {
                //console.log(`POP ${sp} ${mem[sp]}`)
                sp += 4;
                return mem[sp - 4]
            }

            function loop(p: CodePtr) {
                if (_this.dead) {
                    console.log("Runtime terminated")
                    return
                }
                try {
                    runtime = _this
                    while (!!p) {
                        p = p.fn(p.pc)
                        _this.maybeUpdateDisplay()
                    }
                } catch (e) {
                    if (_this.errorHandler)
                        _this.errorHandler(e)
                    else
                        console.error("Simulator crashed, no error handler", e.stack)
                }
            }

            function actionCall(fn: LabelFn, retPC: number, cb?: ResumeFn): CodePtr {
                lr = {
                    caller: lr,
                    retPC: retPC,
                    currFn: fn,
                    baseSP: sp,
                    finalCallback: cb
                }
                return { fn, pc: 0 }
            }

            function leave(v: any): CodePtr {
                let topLr = lr
                lr = lr.caller
                let popped = pop()
                if (popped != topLr) oops("lrpop")
                rr0 = v;
                if (topLr.finalCallback)
                    topLr.finalCallback(v);
                return { fn: lr.currFn, pc: topLr.retPC }
            }

            function setupTop(cb: ResumeFn) {
                setupTopCore(cb)
                setupResume(0)
            }

            function setupTopCore(cb: ResumeFn) {
                let stackTop = _this.malloc();
                sp = stackTop;
                lr = {
                    caller: null,
                    retPC: 0,
                    baseSP: sp,
                    currFn: () => {
                        _this.free(stackTop)
                        if (cb)
                            cb(rr0)
                        return null
                    }
                }
            }

            function topCall(fn: LabelFn, cb: ResumeFn) {
                U.assert(!!_this.board)
                U.assert(!!_this.enums)
                U.assert(!_this.running)
                _this.setRunning(true);
                setupTopCore(cb)
                loop(actionCall(fn, 0))
            }

            function storeRegs() {
                let _lr = lr
                let _sp = sp
                let _r4 = r4
                let _r5 = r5
                let _r6 = r6
                let _r7 = r7
                return () => {
                    lr = _lr
                    sp = _sp
                    r4 = _r4
                    r5 = _r5
                    r6 = _r6
                    r7 = _r7
                }
            }

            function setupResume(retPC: number) {
                if (currResume) oops("already has resume")
                let restore = storeRegs()
                currResume = (v) => {
                    restore();
                    if (v instanceof FnWrapper) {
                        let w = <FnWrapper>v
                        rr0 = w.a0
                        rr1 = w.a1
                        rr2 = w.a2
                        rr3 = w.a3
                        return loop(actionCall(w.func, retPC, w.cb))
                    }
                    rr0 = v;
                    return loop({ fn: lr.currFn, pc: retPC })
                }
            }

            eval(code)

            this.run = (cb) => topCall(entryPoint, cb)
            this.getResume = () => {
                if (!currResume) oops("noresume")
                let r = currResume
                currResume = null
                return r
            }
            this.setupTop = setupTop

            runtime = this;

            let trg = yelm.rt.getTargets().filter(t => t.name == targetName)[0]
            if (!trg) {
                U.userError("target " + targetName + " not supported")
            }

            this.target = trg;
            trg.initCurrentRuntime();
        }
    }
}
