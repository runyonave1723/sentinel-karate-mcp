@ignore
Feature: Helper - Get Product
  Scenario:
    Given url baseUrl
    And path '/api/products/' + id
    When method GET
    Then status 200
