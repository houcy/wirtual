import Utils from './utils';
import CompileError from './errors/compileError';
import Api from './api';

import Scene from './components/scene';

export default class Compiler {

    constructor() {
        Utils.log('Compiler initiated...');

        this.heartbeatRate = 500;
        this.heartbeat = null;
        this.stopHeartbeat = false;

        // Start compilation
        this.initialize();
    }

    initialize() {
        let self = this;
        // Fetch the main container
        let container = document.getElementsByClassName('wr-container');
        // Make sure there is only one container
        if (container.length === 0) { CompileError.containerNotFound(); return; }
        if (container.length > 1) { CompileError.multipleContainersFound(); return; }
        // Stamp it with a random ID
        let randomID = this.stamp(container[0], { parent: null });
        // Set the container as a root element
        Api.get()._setRootElementID(randomID);
        // Stamp and store all the DOM nodes
        this.mark(randomID, 0, function () {
            // Initial compilation
            self.initCompile(null, function () {
                // Init watcher
                self.initHeartbeat();
                // Init the render loop
                self.renderLoop();
            });
        });
    }

    // Mark (stamp and store) every DOM element
    mark(wid, recursionLevel, callback) {
        let elementCurrentDOM = this.getCurrentState(wid);
        // Recurse throuh children
        for (let child of elementCurrentDOM.children) {
            let childID = '';
            // Child is not stamped
            if (!child.dataset.wid) {
                // Stamp child
                childID = this.stamp(child, { parent: wid });
                // Add child to its parent 
                Api.get()._addElementChildren(wid, childID);
            }
            // Child is stamped
            else { childID = child.dataset.wid; }
            // Call recursion with the child
            this.mark(childID, recursionLevel + 1);
        }
        // All elements marked
        if (recursionLevel === 0) {
            if (callback) { callback(); }
        }
    }

    initHeartbeat() {
        let self = this;
        this.heartbeat = setInterval(function () {
            if (!self.stopHeartbeat) { self.scan(null); }
        }, this.heartbeatRate);
    }

    // Scan for changes starting from given element
    // Manage the store, compile / recompile partially when necessary.
    scan(wid) {
        let self = this;
        // If wid not set, start from the root
        if (!wid) { wid = Api.get()._getRootElementID(); }
        let elementStored = this.getStoredState(wid);
        // If the children count changes, something might be unmarked
        // Stop the heartbeat and call mark starting from the current element
        if (this.hasChildrenChange(wid)) {
            // Stop the heartbeat
            this.stopHeartbeat = true;
            // Mark everhthing under current element.
            this.mark(wid, 0, function () {
                // Start heartbeat again
                self.stopHeartbeat = false;
                // Continue scanning from the same element
                scan(wid);
            });
        }
        if (!this.stopHeartbeat) {
            // Only step in if the component has a change
            // Keep stepping in until you find the element that has no change
            // Then, recompile its parent
            if (this.hasChange(wid)) {
                var changedChildrenCount = 0, changedChildren = -1;
                if (elementStored.children) {
                    for (let childID of elementStored.children) {
                        if (self.hasChange(childID)) {
                            changedChildrenCount += 1;
                            changedChildren = childID;
                        }
                    }
                }
                // Only one child has change, step in.
                if (changedChildrenCount === 1 && changedChildren !== -1) { self.scan(changedChildren); }
                // Children has no change -> Change is within element 
                // Has no children -> Change is within element
                // Multiple children has changes -> Just recompile the parent element
                else { self.initCompile(wid); }
            }
        }
    }

    // Initiate the compilation process
    initCompile(wid, callback) {
        let self = this;
        // If wid null, compile from the root element
        if (!wid) { wid = Api.get()._getRootElementID(); }
        // Stop the heartbeat while compiling - or it will cause race conditions 
        // which will end up with unnecessary loops, compilations
        self.stopHeartbeat = true;

        // Evaluate & compile
        self.compile(wid, {}, 0, function () {

            // When children changes, all its parents hash will also change.
            // Re-hash all the parents of the changed item
            self.rehash(wid);

            // Start the heartbeat again
            self.stopHeartbeat = false;

            if (callback) { callback(); }
        });
    }

    // Compile / recompile given element and all its children
    compile(wid, payload, recursionLevel, callback) {
        let self = this;
        Utils.log('Compiling: ' + wid);

        var currentElement = this.getStoredState(wid);
        if (!currentElement){ Utils.log('Element (WID: '+wid+') not found'); return; }
        if (!currentElement.dTarget){ Utils.log('Element DOM target (WID: '+wid+') not found'); return; }
        var currentElementClassName = currentElement.dTarget.className;

        // If payload is null, initiate it with an empty object and sync it
        if (!payload){ payload = {}; }
        this.syncPayload(payload, wid);
        
        /* ------ SCAN CLASSES ------ */

        // Create the scene with the container
        if (currentElementClassName.match('wr-container')) { Scene.compile(currentElement); }
        
        // Parse depth and append it to the payload (for passing on to the child elements)
        if (currentElementClassName.match(/wr-depth-\d*/g)){
            let depth = currentElementClassName.match(/wr-depth-\d*/g)[0];
            try { depth = parseInt(depth.replace('wr-depth-', '').trim()); }
            catch(e){ CompileError.depthNotValid(); return; }
            payload.depth = depth;
        }

        /* -------------------------- */

        // Call recursion for all the children
        if (currentElement.children) {
            for (let childID of currentElement.children) {
                self.compile(childID, payload, recursionLevel + 1, null);
            }
        }
        
        // All elements compiled
        if (recursionLevel === 0) {
            if (callback) { callback(); }
        }
    }

    syncPayload(payload, wid){
        var currentElement = this.getStoredState(wid);
        for (let key in payload){
            // If payload doesn't exist, initiate with an empty object
            if (!currentElement.payload){ currentElement.payload = {}; }
            // Set values of the payload
            // This will update the existing keys and set new ones
            currentElement.payload[key] = payload[key];
        }
    }

    // Rehash the element and all its parents (going up the tree)
    rehash(wid) {
        let self = this;
        var currentStoredState = self.getStoredState(wid);
        while (currentStoredState) {
            var currentWid = currentStoredState.id;
            Utils.log('Rehashing: ' + currentWid);
            var currentDOMState = this.getCurrentState(currentWid);
            Api.get()._setElementField(currentWid, 'hash', self.hash(currentDOMState));
            currentStoredState = self.getStoredState(currentStoredState.parent);
        }
    }


    // Did the structure of HTML changed
    hasChange(wid) {
        // Fetch stored element data 
        let elementStored = this.getStoredState(wid);
        // Get current state of the DOM element
        let elementCurrentDOM = this.getCurrentState(wid);
        /*
        console.log('Current');
        console.log(elementCurrentDOM);
        console.log('Stored');
        console.log(elementStored);
        console.log('Current - hash');
        console.log(this.hash(elementCurrentDOM));
        console.log('Stored - hash');
        console.log(elementStored.hash);
        */
        // DOM change if hashes are not the same
        return elementStored.hash !== this.hash(elementCurrentDOM);
    }

    // Did more elements have been added or some removed
    hasChildrenChange(wid) {
        // Fetch stored element data 
        let elementStored = this.getStoredState(wid);
        // Get current state of the DOM element
        let elementCurrentDOM = this.getCurrentState(wid);
        // Get stored elements children count
        let elementStoredChildren = 0;
        if (elementStored && elementStored.children) {
            elementStoredChildren = elementStored.children.length;
        }
        // Get DOM elements children count
        let elementCurrentDOMChildren = 0;
        if (elementCurrentDOM && elementCurrentDOM.children) {
            elementCurrentDOMChildren = elementCurrentDOM.children.length;
        }
        // More or less child if not equal 
        return elementStoredChildren !== elementCurrentDOMChildren;
    }

    getStoredState(wid) { return Api.get()._getElement(wid); }
    getCurrentState(wid) { return document.querySelectorAll("[data-wid='" + wid + "']")[0]; }

    elementRemovedFromDOM(wid) { }
    isStamped(el) { }

    // Stamp DOM element with a random ID and store
    stamp(el, options) {
        let randomID = '_w' + Utils.random(10);
        el.setAttribute('data-wid', randomID);
        let opts = options || {};
        opts.id = randomID;
        opts.dTarget = el;
        opts.vTarget = null;
        opts.hash = this.hash(el);
        Api.get()._addElement(randomID, opts);
        return randomID;
    }

    hash(el) {
        return el.outerHTML
            // Remove all white spaces
            .replace(/\s/g, '')
            .replace(/\n/g, '')
            .replace(/\t/g, '')
            // Remove all the comments
            .replace(/<!--[\s\S]*?-->/g, '')
            // Remove 'data-wid' properties
            // ie. Parents are marked and stored before its children - causes hash missmatch
            .replace(/data\-wid=(\"|\')(.*?)(\"|\')/gi, '')
            .trim();
    }

    renderLoop(){
        let oldTimestamp = 0;
        function animate(timestamp) {
            // Calculate time since last frame in seconds
            let timestampDelta = (oldTimestamp !== 0) ? (timestamp - oldTimestamp) / 1000.0 : 0.0;
            oldTimestamp = timestamp;
            // Update Animations
            if (THREE.AnimationHandler) { THREE.AnimationHandler.update(timestampDelta); }

            // Execute the runnables atached to the render loop
            let renderLoopRunnables = Api.get().getRenderLoopRunnables();
            for (let runnableIndex in renderLoopRunnables){
                if (renderLoopRunnables[runnableIndex] && typeof renderLoopRunnables[runnableIndex] === 'function'){
                    renderLoopRunnables[runnableIndex](timestamp);
                }
            }

            // Recurse
            requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
    }
}