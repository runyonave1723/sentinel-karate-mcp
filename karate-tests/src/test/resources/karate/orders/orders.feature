@orders
Feature: Order API Tests
  Background:
    * url baseUrl
    * def orderPath = '/api/orders'

  @smoke @create-order
  Scenario: Create order for available product succeeds
    * def newOrder =
    """
    {
      "productId": 5,
      "customerName": "Abarajith S",
      "customerEmail": "abara@test.com",
      "quantity": 2
    }
    """
    Given path orderPath
    And request newOrder
    When method POST
    Then status 201
    And match response.id == '#number'
    And match response.status == 'PENDING'
    And match response.totalPrice == '#number'
    And match response.customerEmail == 'abara@test.com'

  @smoke @get-orders
  Scenario: Get all orders returns list
    Given path orderPath
    When method GET
    Then status 200
    And match response == '#[]'

  @get-by-id
  Scenario: Get order by ID returns order details
    * def order = { productId: 6, customerName: 'Test User', customerEmail: 'test@test.com', quantity: 1 }
    Given path orderPath
    And request order
    When method POST
    Then status 201
    * def createdId = response.id

    Given path orderPath + '/' + createdId
    When method GET
    Then status 200
    And match response.id == createdId

  @negative @get-by-id
  Scenario: Get non-existent order returns 404
    Given path orderPath + '/99999'
    When method GET
    Then status 404

  @filter @get-by-email
  Scenario: Filter orders by customer email
    Given path orderPath
    And param email = 'abara@test.com'
    When method GET
    Then status 200
    And match each response == { id: '#number', productId: '#number', customerName: '#string', customerEmail: 'abara@test.com', quantity: '#number', totalPrice: '#number', status: '#string', createdAt: '#string', updatedAt: '#ignore' }

  @filter @get-by-status
  Scenario: Filter orders by status PENDING
    Given path orderPath
    And param status = 'PENDING'
    When method GET
    Then status 200
    And match each response == { id: '#number', productId: '#number', customerName: '#string', customerEmail: '#string', quantity: '#number', totalPrice: '#number', status: 'PENDING', createdAt: '#string', updatedAt: '#ignore' }

  @update-status
  Scenario: Update order status to CONFIRMED
    * def order = { productId: 7, customerName: 'Status User', customerEmail: 'status@test.com', quantity: 1 }
    Given path orderPath
    And request order
    When method POST
    Then status 201
    * def orderId = response.id

    Given path orderPath + '/' + orderId + '/status'
    And request { status: 'CONFIRMED' }
    When method PATCH
    Then status 200
    And match response.status == 'CONFIRMED'

  @cancel
  Scenario: Cancel a pending order restores stock
    * def order = { productId: 8, customerName: 'Cancel User', customerEmail: 'cancel@test.com', quantity: 1 }
    Given path orderPath
    And request order
    When method POST
    Then status 201
    * def orderId = response.id

    Given path orderPath + '/' + orderId + '/cancel'
    When method POST
    Then status 200
    And match response.status == 'CANCELLED'

  @negative @insufficient-stock
  Scenario: Create order exceeding available stock returns error
    * def bigOrder =
    """
    {
      "productId": 1,
      "customerName": "Greedy User",
      "customerEmail": "greedy@test.com",
      "quantity": 999999
    }
    """
    Given path orderPath
    And request bigOrder
    When method POST
    Then status 400
    And match response.error contains 'Insufficient stock'

  @negative @invalid-product
  Scenario: Create order for non-existent product returns error
    * def badOrder =
    """
    {
      "productId": 99999,
      "customerName": "Test User",
      "customerEmail": "test@test.com",
      "quantity": 1
    }
    """
    Given path orderPath
    And request badOrder
    When method POST
    Then status 400
    And match response.error contains 'Product not found'

  @validation
  Scenario: Create order with invalid email returns 400
    * def invalidOrder =
    """
    {
      "productId": 1,
      "customerName": "Test User",
      "customerEmail": "not-an-email",
      "quantity": 1
    }
    """
    Given path orderPath
    And request invalidOrder
    When method POST
    Then status 400
