/*****************************************************************************
 * Open MCT, Copyright (c) 2014-2021, United States Government
 * as represented by the Administrator of the National Aeronautics and Space
 * Administration. All rights reserved.
 *
 * Open MCT is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Open MCT includes source code licensed under additional open source
 * licenses. See the Open Source Licenses file (LICENSES.md) included with
 * this source code distribution or the Licensing information page available
 * at runtime from the About dialog for additional information.
 *****************************************************************************/

define(
    [
        'lodash',
        'EventEmitter',
        '../TelemetryTableRow'
    ],
    function (
        _,
        EventEmitter,
        TelemetryTableRow
    ) {
        const LESS_THAN = -1;
        const EQUAL = 0;
        const GREATER_THAN = 1;

        /**
         * @constructor
         */
        class TableRowCollection extends EventEmitter {
            constructor(openmct) {
                super();

                this.openmct = openmct;

                this.rows = [];
                this.telemetryObjects = {}; // maybe object container everything
                this.telemetryCollections = {};

                // remove
                this.datumCache = [];
                this.removeDatumCache = [];

                this.columnFilters = {};
                this.paused = false;
                this.outstandingRequests = 0;

                this.addObject = this.addObject.bind(this);
                this.removeObject = this.removeObject.bind(this);
                this.removeTelemetryCollection = this.removeTelemetryCollection.bind(this);
                this.clear = this.clear.bind(this);
            }

            pause() {
                this.paused = true;
            }

            unpause() {
                this.paused = true;
            }

            addObject(telemetryObject, configuration) {
                let { keyString, requestOptions, columnMap } = configuration;
                let limitEvaluator = this.openmct.telemetry.limitEvaluator(telemetryObject);

                this.incrementOutstandingRequests();

                const telemetryProcessor = this.getTelemetryProcessor(telemetryObject, keyString, columnMap, limitEvaluator);
                const telemetryRemover = this.getTelemetryRemover(keyString);

                this.removeTelemetryCollection(keyString);

                this.telemetryCollections[keyString] = this.openmct.telemetry
                    .requestTelemetryCollection(telemetryObject, requestOptions);

                this.telemetryCollections[keyString].on('remove', telemetryRemover);
                this.telemetryCollections[keyString].on('add', telemetryProcessor);
                this.telemetryCollections[keyString].load();

                this.decrementOutstandingRequests();

                this.telemetryObjects[keyString] = {
                    telemetryObject,
                    keyString,
                    requestOptions,
                    columnMap,
                    limitEvaluator
                };
            }

            removeObject(objectIdentifier) {
                const keyString = this.openmct.objects.makeKeyString(objectIdentifier);
                let removed = [];

                this.rows = this.rows.filter((row) => {
                    if (row.objectKeyString !== keyString) {
                        removed.push(row);

                        return false;
                    } else {
                        return true;
                    }
                });

                this.emit('remove', removed);
                this.removeTelemetryCollection(keyString);
                delete this.telemetryObjects[keyString];
            }

            removeTelemetryCollection(keyString) {
                if (this.telemetryCollections[keyString]) {
                    this.telemetryCollections[keyString].destroy();
                    this.telemetryCollections[keyString] = undefined;
                    delete this.telemetryCollections[keyString];
                }
            }

            getTelemetryProcessor(telemetryObject, keyString, columnMap, limitEvaluator) {
                return (telemetry) => {
                    //Check that telemetry object has not been removed since telemetry was requested.
                    if (!this.telemetryObjects[keyString]) {
                        return;
                    }

                    // only cache realtime
                    if (this.paused) {
                        let cacheData = {
                            telemetry,
                            columnMap,
                            keyString,
                            limitEvaluator
                        };

                        this.datumCache.push(cacheData);
                    } else {
                        this.processTelemetryData(telemetry, columnMap, keyString, limitEvaluator);
                    }
                };
            }

            getTelemetryRemover(keyString) {
                return (telemetry) => {
                    // only cache realtime
                    if (this.paused) {
                        this.removeDatumCache = this.removeDatumCache.concat(telemetry);
                    } else {
                        this.removeTheseRowIds(telemetry.map(JSON.stringify));
                    }
                };
            }

            processTelemetryData(telemetryData, columnMap, keyString, limitEvaluator) {
                // anything coming from telemetry collection is in bounds and will be added (unless filtered)
                let telemetryRows = telemetryData.map(datum => new TelemetryTableRow(datum, columnMap, keyString, limitEvaluator));

                if (this.sortOptions === undefined) {
                    throw 'Please specify sort options';
                }

                this.addRows(telemetryRows);
            }

            addRows(rows, skipEmit = false) {
                let isFiltered = Object.keys(this.columnFilters).length > 0;
                let rowsToAdd = !isFiltered ? rows : rows.filter(this.matchesFilters, this);

                for (let row of rowsToAdd) {
                    let index = this.sortedIndex(this.rows, row, 'sorted');
                    this.rows.splice(index, 0, row);
                }

                if (!skipEmit && rowsToAdd.length > 0) {
                    this.emit('add', rowsToAdd);
                }
            }

            processDatumCache() {
                this.datumCache.forEach(cachedDatum => {
                    this.processTelemetryData(cachedDatum.telemetry, cachedDatum.columnMap, cachedDatum.keyString, cachedDatum.limitEvaluator);
                });
                this.datumCache = [];
                this.removeTheseRowIds(this.removeDatumCache.map(JSON.stringify));
                this.removeDatumCache = [];
            }

            removeRows() {
                // todo
            }

            sortedLastIndex(rows, testRow, type) {
                return this.sortedIndex(rows, testRow, type, _.sortedLastIndex);
            }

            /**
             * Finds the correct insertion point for the given row.
             * Leverages lodash's `sortedIndex` function which implements a binary search.
             * @private
             */
            sortedIndex(rows, testRow, type, lodashFunction = _.sortedIndexBy) {
                if (this.rows.length === 0) {
                    return 0;
                }

                const testRowValue = this.getValueForSortColumn(testRow);
                const firstValue = this.getValueForSortColumn(this.rows[0]);
                const lastValue = this.getValueForSortColumn(this.rows[this.rows.length - 1]);

                if (this.sortOptions.direction === 'asc') {
                    if (testRowValue > lastValue) {
                        return this.rows.length;
                    } else if (testRowValue === lastValue) {
                        // Maintain stable sort
                        return this.rows.length;
                    } else if (testRowValue <= firstValue) {
                        return 0;
                    } else {
                        return lodashFunction(rows, testRow, (thisRow) => {
                            return this.getValueForSortColumn(thisRow);
                        });
                    }
                } else {
                    if (testRowValue >= firstValue) {
                        return 0;
                    } else if (testRowValue < lastValue) {
                        return this.rows.length;
                    } else if (testRowValue === lastValue) {
                        // Maintain stable sort
                        return this.rows.length;
                    } else {
                        // Use a custom comparison function to support descending sort.
                        return lodashFunction(rows, testRow, (thisRow) => {
                            const thisRowValue = this.getValueForSortColumn(thisRow);
                            if (testRowValue === thisRowValue) {
                                return EQUAL;
                            } else if (testRowValue < thisRowValue) {
                                return LESS_THAN;
                            } else {
                                return GREATER_THAN;
                            }
                        });
                    }
                }
            }

            removeTheseRowIds(rowIds) {
                let removed = [];

                this.rows = this.rows.filter((row) => {
                    if (rowIds.includes(row.rowId)) {
                        removed.push(row);

                        return false;
                    } else {
                        return true;
                    }
                });

                this.emit('remove', removed);
            }

            /**
             * Sorts the telemetry collection based on the provided sort field
             * specifier. Subsequent inserts are sorted to maintain specified sport
             * order.
             *
             * @example
             * // First build some mock telemetry for the purpose of an example
             * let now = Date.now();
             * let telemetry = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (value) {
             *     return {
             *         // define an object property to demonstrate nested paths
             *         timestamp: {
             *             ms: now - value * 1000,
             *             text:
             *         },
             *         value: value
             *     }
             * });
             * let collection = new TelemetryCollection();
             *
             * collection.add(telemetry);
             *
             * // Sort by telemetry value
             * collection.sortBy({
             *  key: 'value', direction: 'asc'
             * });
             *
             * // Sort by ms since epoch
             * collection.sort({
             *  key: 'timestamp.ms',
             *  direction: 'asc'
             * });
             *
             * // Sort by 'text' attribute, descending
             * collection.sort("timestamp.text");
             *
             *
             * @param {object} sortOptions An object specifying a sort key, and direction.
             */
            sortBy(sortOptions) {
                if (arguments.length > 0) {
                    this.sortOptions = sortOptions;
                    this.rows = _.orderBy(this.rows, (row) => row.getParsedValue(sortOptions.key), sortOptions.direction);

                    this.emit('sort');
                }

                // Return duplicate to avoid direct modification of underlying object
                return Object.assign({}, this.sortOptions);
            }

            setColumnFilter(columnKey, filter) {
                filter = filter.trim().toLowerCase();

                if (!this.isSubsetOfCurrentFilter(columnKey, filter)) {
                    this.updateRowsToAllBoundedRows();
                }

                if (filter.length === 0) {
                    delete this.columnFilters[columnKey];
                } else {
                    this.columnFilters[columnKey] = filter;
                }

                this.rows = this.rows.filter(this.matchesFilters, this);
                this.emit('filter');
            }

            setColumnRegexFilter(columnKey, filter) {
                filter = filter.trim();

                this.columnFilters[columnKey] = new RegExp(filter);

                this.rows = this.rows.filter(this.matchesFilters, this);
                this.emit('filter');
            }

            updateRowsToAllBoundedRows() {
                let objectKeys = Object.keys(this.telemetryCollections);
                let allBoundedRows = objectKeys.reduce((boundedRows, keyString) => {
                    let { columnMap, limitEvaluator } = this.telemetryObjects[keyString];

                    return boundedRows.concat(this.telemetryCollections[keyString].boundedTelemetry.map(
                        datum => new TelemetryTableRow(datum, columnMap, keyString, limitEvaluator)
                    ));
                }, []);

                // sorts them
                this.rows = [];
                this.addRows(allBoundedRows, true);
            }

            /**
             * @private
             */
            isSubsetOfCurrentFilter(columnKey, filter) {
                if (this.columnFilters[columnKey] instanceof RegExp) {
                    return false;
                }

                return this.columnFilters[columnKey]
                    && filter.startsWith(this.columnFilters[columnKey])
                    // startsWith check will otherwise fail when filter cleared
                    // because anyString.startsWith('') === true
                    && filter !== '';
            }

            /**
             * @private
             */
            matchesFilters(row) {
                let doesMatchFilters = true;
                Object.keys(this.columnFilters).forEach((key) => {
                    if (!doesMatchFilters || !this.rowHasColumn(row, key)) {
                        return false;
                    }

                    let formattedValue = row.getFormattedValue(key);
                    if (formattedValue === undefined) {
                        return false;
                    }

                    if (this.columnFilters[key] instanceof RegExp) {
                        doesMatchFilters = this.columnFilters[key].test(formattedValue);
                    } else {
                        doesMatchFilters = formattedValue.toLowerCase().indexOf(this.columnFilters[key]) !== -1;
                    }
                });

                return doesMatchFilters;
            }

            rowHasColumn(row, key) {
                return Object.prototype.hasOwnProperty.call(row.columns, key);
            }

            getRows() {
                return this.rows;
            }

            getRowsLength() {
                return this.rows.length;
            }

            getValueForSortColumn(row) {
                return row.getParsedValue(this.sortOptions.key);
            }

            /**
             * @private
             */
            incrementOutstandingRequests() {
                if (this.outstandingRequests === 0) {
                    this.emit('outstanding-requests', true);
                }

                this.outstandingRequests++;
            }

            /**
             * @private
             */
            decrementOutstandingRequests() {
                this.outstandingRequests--;

                if (this.outstandingRequests === 0) {
                    this.emit('outstanding-requests', false);
                }
            }

            clear() {
                let removedRows = this.rows;
                this.rows = [];

                this.emit('remove', removedRows);
            }

            resubscribe() {
                let objectKeys = Object.keys(this.telemetryObjects);
                objectKeys.forEach((keyString) => {
                    this.addObject(this.telemetryObjects[keyString].telemetryObject, this.telemetryObjects[keyString]);
                });
                // this.telemetryObjects.forEach(this.addObject.bind(this));
            }

            clearAndResubscribe() {
                this.clear();
                this.resubscribe();
            }

            destroy() {
                let keystrings = Object.keys(this.telemetryCollections);
                keystrings.forEach(this.removeTelemetryCollection, this);

                this.removeAllListeners();
            }
        }

        return TableRowCollection;
    });