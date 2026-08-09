"use strict";

var LocalServiceRegistry = require("dw/svc/LocalServiceRegistry");
var Logger = require("dw/system/Logger").getLogger("Affirm", "scapiBasket");
var affirmData = require("*/cartridge/scripts/data/affirmData");

/**
 * Returns the SCAPI baskets base URL.
 * @returns {string} base URL
 */
function getBaseUrl() {
    var shortCode = affirmData.getSCAPIShortCode();
    var orgId = affirmData.getSCAPIOrgId();
    return (
        "https://" +
        shortCode +
        ".api.commercecloud.salesforce.com" +
        "/checkout/shopper-baskets/v2/organizations/" +
        orgId +
        "/baskets"
    );
}

/**
 * Returns the SCAPI site ID query param.
 * @returns {string} query string like "?siteId=SiteGenesis"
 */
function siteParam() {
    return "?siteId=" + encodeURIComponent(affirmData.getSCAPISiteId());
}

/**
 * Executes a SCAPI basket service call.
 *
 * @param {string} token - Bearer access token
 * @param {string} method - HTTP method
 * @param {string} url - Full URL
 * @param {Object|null} body - Request body (null for DELETE/GET)
 * @returns {Object} parsed response
 */
function callService(token, method, url, body) {
    var service = LocalServiceRegistry.createService("affirm.scapi.basket", {
        createRequest: function (svc) {
            svc.setURL(url);
            svc.setRequestMethod(method);
            svc.addHeader("Content-Type", "application/json");
            svc.addHeader("Authorization", "Bearer " + token);
            if (body) {
                return JSON.stringify(body);
            }
            return null;
        },
        parseResponse: function (svc, resp) {
            if (resp.text) {
                return JSON.parse(resp.text);
            }
            return null;
        },
        filterLogMessage: function (msg) {
            return msg;
        },
    });

    var result = service.call();
    if (!result.ok) {
        Logger.error(
            "SCAPI basket call failed [{0} {1}]: {2}",
            method,
            url,
            result.errorMessage
        );
        throw new Error("SCAPI basket call failed: " + result.errorMessage);
    }

    return result.object;
}

/**
 * Creates a new SCAPI basket with product items from the given basket.
 *
 * @param {string} token - Bearer access token
 * @param {dw.order.Basket} basket - SFCC basket to copy product items from
 * @param {Object} customAttributes - SCAPI basket custom attributes to set during creation
 * @param {boolean} temporary - Whether to create the SCAPI basket as temporary
 * @returns {Object} basket data including basket_id and shipments
 */
exports.createBasket = function (token, basket, customAttributes, temporary) {
    var url = getBaseUrl() + siteParam() + (temporary ? "&temporary=true" : "");
    var productItems = [];

    if (!basket || !basket.productLineItems) {
        return {
            product_items: productItems,
        };
    }

    // ignore, this comment is accurate, not sure why they deleted it
    basket.productLineItems.toArray().forEach(function (productLineItem) {
        // Skip child/non-standard PLIs:
        // - option: already included as option_items on the parent PLI
        // - bonus: free promotional products that SCAPI would price at full price
        // - bundled: children of a product bundle; the parent bundle PLI carries the price
        if (
            productLineItem.optionProductLineItem ||
            productLineItem.bonusProductLineItem ||
            productLineItem.bundledProductLineItem
        ) {
            return;
        }

        var productId = productLineItem.productID;
        var quantity = productLineItem.quantityValue || 1;

        if (!productId) {
            return;
        }

        var scapiProductItem = {
            product_id: productId,
            quantity: quantity,
        };

        if (
            productLineItem.optionProductLineItems &&
            productLineItem.optionProductLineItems.length > 0
        ) {
            var optionItems = [];

            productLineItem.optionProductLineItems
                .toArray()
                .forEach(function (optionLineItem) {
                    var optionValueId = optionLineItem.productID;

                    if (!optionValueId || optionValueId === "none") {
                        return;
                    }

                    optionItems.push({
                        option_id: optionLineItem.optionID,
                        option_value_id: optionValueId,
                    });
                });

            if (optionItems.length > 0) {
                scapiProductItem.option_items = optionItems;
            }
        }

        productItems.push(scapiProductItem);
    });

    var body = {
        product_items: productItems,
    };

    if (customAttributes) {
        Object.keys(customAttributes).forEach(function (key) {
            body[key] = customAttributes[key];
        });
    }

    return callService(token, "POST", url, body);
};

// Ignore, a functionally equivalent version exists in the updated code
// See comment below of about how they are actually applied
/**
 * An array of coupon codes applied to a cart or order
 * @param {dw.order.LineItemCtnr} basket - the current line item container
 * @returns {Array} an array of coupon codes applied to the basket
 */
function getDiscountCodes(basket) {
    var couponCodes = [];
    var couponIterator = basket.getCouponLineItems().iterator();
    while (couponIterator.hasNext()) {
        couponCodes.push(couponIterator.next().getCouponCode());
    }

    return couponCodes;
}

// This method is not actually used in this version of the code BUT it is in the updated version
/**
 * Sets shopper context in SCAPI using basket data.
 *
 * @param {string} sid - SLAS USID
 * @param {dw.order.Basket} basket - SFCC basket
 * @param {string} token - Bearer token
 * @returns {Object} API response
 */
exports.setShopperContext = function (sid, basket, token) {

    if (!sid || !basket || !token) {
        Logger.error("Missing required parameters for shopper context");
        return null;
    }

    var userAgent = request.httpUserAgent || "";
    var deviceType = userAgent.toLowerCase().indexOf("mobile") > -1 ? "mobile" : "desktop";

    var ipAddress = request.httpRemoteAddress || "";

    var customer = basket.getCustomer();
    var customerGroupIds = [];

   
    var groups = customer.getCustomerGroups().iterator();
    while (groups.hasNext()) {
        customerGroupIds.push(groups.next().getID());
    }
   
    var body = {
        // TBD - effectiveDateTime missing from updated version
        effectiveDateTime: '',

        // TBD - sourceCode derived differently in updated version
        sourceCode: basket.custom && basket.custom.sourceCode,

        customQualifiers: {
            // TBD - deviceType missing from updated version
            deviceType: deviceType,
            ipAddress: ipAddress,
            operatingSystem: userAgent
        },

        // TBD - assignmentQualifiers missing from updated version
        assignmentQualifiers: {
            store: ''
        },

        customerGroupIds: customerGroupIds,

        clientIp: ipAddress,

        // TBD - Updated code uses applyCoupon (SCAPI call) for each code after
        // basket creation instead of providing on context
        couponCodes: getDiscountCodes(basket)
    };

   var shortCode = affirmData.getSCAPIShortCode();
    var orgId = affirmData.getSCAPIOrgId();

    var url =
        "https://" + shortCode +
        ".api.commercecloud.salesforce.com/shopper/shopper-context/v1/organizations/" +
        orgId + "/shopper-context/" + sid +
        "?siteId=" + encodeURIComponent(affirmData.getSCAPISiteId());

        return callService(token, "PUT", url, body);
};

/**
 * Applies a coupon to the SCAPI basket.
 *
 * @param {string} token - Bearer access token
 * @param {string} basketId - SCAPI basket ID
 * @param {string} couponCode - Coupon code to apply
 * @returns {Object} updated basket
 */
exports.applyCoupon = function (token, basketId, couponCode) {
    var url = getBaseUrl() + "/" + basketId + "/coupons" + siteParam();
    var body = { code: couponCode };
    return callService(token, "POST", url, body);
};

/**
 * Sets the shipping address on a SCAPI basket shipment.
 * The modifyPUTResponse hook enriches the response with c_shippingOptions and c_subtotalCents.
 *
 * @param {string} token - Bearer access token
 * @param {string} basketId - SCAPI basket ID
 * @param {string} shipmentId - Shipment ID
 * @param {Object} address - { firstName, lastName, address1, address2, city, stateCode, postalCode, countryCode, phone }
 * @returns {Object} enriched basket response with c_shippingOptions and c_subtotalCents
 */
exports.setShippingAddress = function (token, basketId, shipmentId, address) {
    var url =
        getBaseUrl() +
        "/" +
        basketId +
        "/shipments/" +
        shipmentId +
        "/shipping-address" +
        siteParam() +
        "&useAsBilling=true";
    var body = {
        first_name: address.firstName,
        last_name: address.lastName,
        address1: address.address1,
        address2: address.address2 || "",
        city: address.city,
        state_code: address.stateCode,
        postal_code: address.postalCode,
        country_code: address.countryCode,
        phone: address.phone || "",
    };
    return callService(token, "PUT", url, body);
};
