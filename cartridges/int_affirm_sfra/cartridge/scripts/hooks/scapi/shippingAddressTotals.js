"use strict";

var ShippingMgr = require("dw/order/ShippingMgr");
var HookMgr = require("dw/system/HookMgr");
var Logger = require("dw/system/Logger").getLogger(
    "Affirm",
    "shippingAddressTotals"
);

/**
* Plain JS object that represents a DW Script API dw.order.ShippingMethod object
* @param {dw.order.Shipment} shipment - the target Shipment
* @param {Object} [address] - optional address object
* @returns {dw.util.Collection} an array of ShippingModels
*/
function getApplicableShippingMethods(shipment, address) {
    var Site = require('dw/system/Site');
    var collections = require('*/cartridge/scripts/util/collections');

    if (!shipment) {
        return [];
    }

    var shippingRestrictionsHelper = require('*/cartridge/scripts/helpers/shippingRestrictionsHelper');
    var countrySpecificConfig = require('*/cartridge/scripts/helpers/countrySpecificConfigHelper');

    var inventoryFailureOrHazmatCheck = false;

    if (Site.current.getCustomPreferenceValue('enableCountrySelector') && !empty(shipment.shippingAddress)) {
        inventoryFailureOrHazmatCheck = countrySpecificConfig.checkProductInventory(shipment);
        inventoryFailureOrHazmatCheck = inventoryFailureOrHazmatCheck || countrySpecificConfig.checkProductHazmat(shipment);
        inventoryFailureOrHazmatCheck = inventoryFailureOrHazmatCheck || countrySpecificConfig.checkDropShipProduct(shipment);
    }

    var materialBasedShippingRestrictionMsg = '';

    if (address) {
        materialBasedShippingRestrictionMsg = shippingRestrictionsHelper.getShippingRestrictionMaterialMsg(
            shipment,
            address.stateCode
        );
    } else if (shipment.shippingAddress) {
        materialBasedShippingRestrictionMsg = shippingRestrictionsHelper.getShippingRestrictionMaterialMsg(
            shipment,
            shipment.shippingAddress.stateCode
        );
    }

    var filteredMethods = [];
    var isCustomized = false;

    collections.forEach(shipment.productLineItems, function (productLineItem) {
        if (
            !empty(productLineItem.custom.productCustomizationTransactionID) ||
            !empty(productLineItem.custom.productCustomizationAssemblyID)
        ) {
            isCustomized = true;
        }
    });

    var shipmentShippingModel = ShippingMgr.getShipmentShippingModel(shipment);
    var enableToRestrictStoreInventory = false;

    if (shipment.shippingAddress && shipment.shippingAddress.address1) {
        var ProductInventoryMgr = require('dw/catalog/ProductInventoryMgr');
        var dcInventoryListId = Site.getCurrent().getCustomPreferenceValue('dcInventoryListId');
        var productInventory = ProductInventoryMgr.getInventoryList(dcInventoryListId);

        var restrictStoreInventoryShipping = collections.find(
            shipmentShippingModel.applicableShippingMethods,
            function (applicableShippingMethod) {
                return applicableShippingMethod.custom &&
                    applicableShippingMethod.custom.enableToRestrictStoreInventory;
            }
        );

        var restrictStoreInventoryForDropShip = Site.getCurrent().getCustomPreferenceValue('restrictStoreInventoryForDropShip');

        collections.forEach(shipment.productLineItems, function (productLineItem) {
            var productExistInInventory = productInventory ?
                productInventory.getRecord(productLineItem.productID) :
                null;

            if (
                (
                    restrictStoreInventoryShipping ||
                    (
                        restrictStoreInventoryForDropShip &&
                        productLineItem.product &&
                        productLineItem.product.custom.eligibleForDropShip
                    )
                ) &&
                !(productLineItem.custom && productLineItem.custom.fromStoreId) &&
                (
                    empty(productExistInInventory) ||
                    (
                        !empty(productExistInInventory) &&
                        !productExistInInventory.perpetual &&
                        productExistInInventory.ATS.value < 1
                    )
                )
            ) {
                enableToRestrictStoreInventory = true;
            }
        });
    }

    if (
        materialBasedShippingRestrictionMsg === '' &&
        !inventoryFailureOrHazmatCheck &&
        !enableToRestrictStoreInventory
    ) {
        var shippingMethods;
        var shippingAddress;

        if (address) {
            shippingMethods = shipmentShippingModel.getApplicableShippingMethods(address);
        } else if (shipment.getShippingAddress() && shipment.getShippingAddress().getPostalCode()) {
            shippingAddress = getAddressFromShipment(shipment.getShippingAddress());
            shippingMethods = shipmentShippingModel.getApplicableShippingMethods(shippingAddress);
        } else {
            shippingMethods = shipmentShippingModel.getApplicableShippingMethods({});
        }

        collections.forEach(shippingMethods, function (shippingMethod) {
            if (
                isCustomized &&
                (
                    shippingMethod.custom.disableShippingForMonogrammedItems ||
                    shippingMethod.custom.disableShippingForCustomizableItems ||
                    shippingMethod.custom.disableShippingForMTOItems
                )
            ) {
                return;
            }

            if (!shippingMethod.custom.storePickupEnabled) {
                filteredMethods.push(shippingMethod);
            }
        });

        filteredMethods.sort(function (a, b) {
            var amountA = shipmentShippingModel.getShippingCost(a).amount.value;
            var amountB = shipmentShippingModel.getShippingCost(b).amount.value;

            return amountA - amountB;
        });
    }

    return filteredMethods;
}

/**
 * SCAPI hook: dw.ocapi.shop.basket.shipment.shipping_address.afterPUT
 *
 * Runs inside a transactional context so that external tax providers
 * (Vertex, Avalara, etc.) honour the calculate call and return live tax
 * values for each shipping method.  Results are stored on request.custom
 * so the read-only modifyPUTResponse hook can attach them to the response.
 *
 * @param {dw.order.Basket} basket - the basket based on which the order is created
 * @param {dw.order.Shipment} shipment - the shipment information for the shipment creation
 * @param {OrderAddress} shippingAddress - the shipping address that was set to the shipment (OrderAddressWO — plain properties, no getters)
 */
exports.afterPUT = function (basket, shipment, shippingAddress) {
    try {
        if (!basket || !basket.custom || basket.custom.isAffirmExpressCheckout !== true) {
            return;
        }

        if (!shippingAddress) {
            return;
        }

        // shippingAddress is an OrderAddressWO — use plain property access
        var addressObj = {
            address1 : shippingAddress.address1 || "",
            address2 : shippingAddress.address2 || "",
            countryCode: shippingAddress.countryCode || "US",
            stateCode: shippingAddress.stateCode || "",
            postalCode: shippingAddress.postalCode || "",
            city: shippingAddress.city || "",
        };

        var applicableShippingMethods = getApplicableShippingMethods (shipment, addressObj);
            
        var currentShippingMethod =
            shipment.getShippingMethod() ||
            ShippingMgr.getDefaultShippingMethod();

        var shippingOptions = [];
        
        for (var i = 0; i < applicableShippingMethods.length; i++) {
            var shippingMethod = applicableShippingMethods[i];

            try {
                shipment.setShippingMethod(shippingMethod);
                HookMgr.callHook("dw.order.calculate", "calculate", basket);

                var shippingAmount = Math.round(
                    basket.getAdjustedShippingTotalPrice().getValue() * 100
                );
                var taxAmount = Math.round(
                    basket.getTotalTax().getValue() * 100
                );
                var totalAmount = Math.round(
                    basket.getTotalGrossPrice().getValue() * 100
                );

                shippingOptions.push({
                    shipping_type: shippingMethod.getID(),
                    shipping_label: shippingMethod.getDisplayName(),
                    shipping_amount: shippingAmount,
                    tax_amount: taxAmount,
                    total: totalAmount,
                });
            } catch (e) {
                Logger.error(
                    "shippingAddressTotals afterPUT error: {0}",
                    e.message
                );
            } finally {
                shipment.setShippingMethod(currentShippingMethod);
                HookMgr.callHook("dw.order.calculate", "calculate", basket);
            }
        }
        var subtotalCents = Math.round(
            basket.getAdjustedMerchandizeTotalPrice(true).getValue() * 100
        );
        // Affirm currently preselects the first shipping method in the array
        // So we need to move the user's selected (or site default) shipping method to the front
        if (currentShippingMethod) {
            var preferredId = currentShippingMethod.getID();
            var preferredIdx = -1;
            for (var j = 0; j < shippingOptions.length; j++) {
                if (shippingOptions[j].shipping_type === preferredId) {
                    preferredIdx = j;
                    break;
                }
            }
            if (preferredIdx > 0) {
                var preferredOption = shippingOptions.splice(preferredIdx, 1)[0];
                shippingOptions.unshift(preferredOption);
            }
        }

        var result = {
            shippingOptions: shippingOptions,
            subtotalCents: subtotalCents,
        };

        request.custom.affirmShippingTotals = JSON.stringify(result);
    } catch (e) {
        Logger.error("shippingAddressTotals afterPUT error: {0}", e.message);
    }
};

/**
 * SCAPI hook: dw.ocapi.shop.basket.shipment.shipping_address.modifyPUTResponse
 *
 * Read-only hook that retrieves pre-calculated shipping totals from
 * request.custom (populated by afterPUT) and attaches them to the
 * SCAPI response.
 *
 * @param {dw.order.Basket} basket - The basket being modified
 * @param {Object} basketResponse - The SCAPI response object to enrich
 * @param {Object} orderAddressRequest - The SCAPI order address request
 */
exports.modifyPUTResponse = function (basket, basketResponse, orderAddressRequest) {
    try {
        if (!basket || !basket.custom || basket.custom.isAffirmExpressCheckout !== true) {
            return;
        }

        var raw = request.custom.affirmShippingTotals;
        if (!raw) {
            return;
        }

        var data = JSON.parse(raw);
        basketResponse.c_shippingOptions = data.shippingOptions;
        basketResponse.c_subtotalCents = data.subtotalCents;
    } catch (e) {
        Logger.error(
            "shippingAddressTotals modifyPUTResponse error: {0}",
            e.message
        );
    }
};
