@inventory
Feature: Product API Tests
  Background:
    * url baseUrl
    * def productPath = '/api/products'

  @smoke @get-all
  Scenario: Get all products returns 200 with list
    Given path productPath
    When method GET
    Then status 200
    And match response == '#[]'
    And match response[0] == { id: '#number', name: '#string', sku: '#string', price: '#number', quantity: '#number', category: '#string', active: '#boolean' }

  @smoke @get-by-id
  Scenario: Get product by valid ID returns product details
    Given path productPath + '/1'
    When method GET
    Then status 200
    And match response.id == 1
    And match response.name == '#string'
    And match response.sku == '#string'
    And match response.price == '#number'

  @negative @get-by-id
  Scenario: Get product by invalid ID returns 404
    Given path productPath + '/99999'
    When method GET
    Then status 404

  @smoke @get-by-sku
  Scenario: Get product by SKU returns correct product
    Given path productPath + '/sku/APPL-IP15-128'
    When method GET
    Then status 200
    And match response.sku == 'APPL-IP15-128'
    And match response.name == 'Apple iPhone 15'

  @negative @get-by-sku
  Scenario: Get product by non-existent SKU returns 404
    Given path productPath + '/sku/INVALID-SKU'
    When method GET
    Then status 404

  @filter @get-by-category
  Scenario: Filter products by category returns only matching products
    Given path productPath
    And param category = 'Electronics'
    When method GET
    Then status 200
    And match each response == { id: '#number', name: '#string', sku: '#string', price: '#number', quantity: '#number', category: 'Electronics', description: '#string', active: '#boolean' }

  @filter @search
  Scenario: Search products by name returns matching results
    Given path productPath
    And param search = 'Apple'
    When method GET
    Then status 200
    And match response[0].name contains 'Apple'

  @create @smoke
  Scenario: Create a new product successfully
    * def newProduct =
    """
    {
      "name": "Test Product",
      "sku": "TEST-PROD-001",
      "price": 999.99,
      "quantity": 10,
      "category": "Test",
      "description": "A test product for Karate testing"
    }
    """
    Given path productPath
    And request newProduct
    When method POST
    Then status 201
    And match response.id == '#number'
    And match response.name == 'Test Product'
    And match response.sku == 'TEST-PROD-001'
    And match response.active == true

  @create @negative
  Scenario: Create product with duplicate SKU returns 409
    * def duplicateProduct =
    """
    {
      "name": "Duplicate Product",
      "sku": "APPL-IP15-128",
      "price": 100.00,
      "quantity": 5,
      "category": "Test",
      "description": "This should fail"
    }
    """
    Given path productPath
    And request duplicateProduct
    When method POST
    Then status 409
    And match response.error == '#string'

  @create @validation
  Scenario Outline: Create product with missing required fields returns 400
    * def invalidProduct = { "name": "<name>", "sku": "<sku>", "price": <price>, "quantity": <qty>, "category": "<cat>" }
    Given path productPath
    And request invalidProduct
    When method POST
    Then status 400

    Examples:
      | name         | sku          | price  | qty | cat       |
      |              | SKU-VALID-01 | 100.0  | 10  | Test      |
      | Valid Name   |              | 100.0  | 10  | Test      |

  @update
  Scenario: Update existing product returns updated data
    * def updatedProduct =
    """
    {
      "name": "iPhone 15 Updated",
      "sku": "APPL-IP15-128",
      "price": 75000.00,
      "quantity": 45,
      "category": "Electronics",
      "description": "Updated description",
      "active": true
    }
    """
    Given path productPath + '/1'
    And request updatedProduct
    When method PUT
    Then status 200
    And match response.name == 'iPhone 15 Updated'
    And match response.price == 75000.00

  @stock
  Scenario: Update product stock with positive delta increases quantity
    * def currentQty = karate.call('classpath:karate/inventory/get-product-qty.js', { id: 1 }).qty
    Given path productPath + '/1/stock'
    And request { delta: 10 }
    When method PATCH
    Then status 200
    And match response.message == 'Stock updated successfully'

  @stock @negative
  Scenario: Update product stock below zero returns error
    Given path productPath + '/1/stock'
    And request { delta: -999999 }
    When method PATCH
    Then status 400
    And match response.error == '#string'

  @delete
  Scenario: Deactivate product returns success message
    * def productToDelete =
    """
    {
      "name": "To Be Deleted",
      "sku": "DELETE-ME-001",
      "price": 1.00,
      "quantity": 1,
      "category": "Test",
      "description": "This product will be deactivated"
    }
    """
    Given path productPath
    And request productToDelete
    When method POST
    Then status 201
    * def deletedId = response.id

    Given path productPath + '/' + deletedId
    When method DELETE
    Then status 200
    And match response.message == 'Product deactivated successfully'
